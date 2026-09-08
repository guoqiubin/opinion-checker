// Vercel Serverless Function: /api/_guard（公共风控模块，v2.5.0）
// 职责：
//   1) 身份识别：IP（x-vercel-forwarded-for / x-forwarded-for）+ 匿名设备ID（X-Device-Id）组合 clientKey
//   2) 窗口限流：优先计数存 Supabase rate_limit 表；表不可用时 fail-open 降级为进程内内存窗口近似并 console.warn
//   3) 管理密钥失败冻结：同 IP 连续失败 5 次冻结 15 分钟（Supabase + 内存双写，任一可用即生效）
//   4) 全站 AI 日熔断（默认 500 次/天，计数存 Supabase 单行，表不可用时内存近似）
// 超限统一返回 429 + 友好 JSON：{ ok:false, code, error }，code 供前端识别、error 供直接展示。
// 阈值常量集中在下方 LIMITS / FAIL_FREEZE，便于调参。
// 说明：本文件无对外业务能力；若被 Vercel 误当作函数路由暴露，返回 404。
import crypto from 'crypto';

// ---------------- 阈值常量（集中调参） ----------------
export const LIMITS = {
  // AI 成本型：同身份 12 次/分钟 且 120 次/小时；另受全站日熔断 DAILY.ai 约束
  ai: { minute: 12, hour: 120 },
  // 管理写：同 IP 30 次/分钟
  admin: { minute: 30 },
  // 宽松只读：公开列表/详情读取，阈值显著高于业务频率，仅挡脚本连发
  read: { minute: 120 }
};
// 全站 AI 日熔断：默认 500 次/天（UTC 自然日），计数存 Supabase 单行
export const DAILY_LIMIT = 500;
// 管理密钥失败冻结：同 IP 连续失败 5 次 → 冻结 15 分钟
export const FAIL_FREEZE = { maxFail: 5, freezeMs: 15 * 60 * 1000 };
// 表不可用后的内存降级 TTL 状态保留时间（防进程内无限膨胀，近似窗口远超真实窗口即可）
const MEM_TTL_MS = 3 * 60 * 60 * 1000;

const TABLE = 'rate_limit';
const RATE_MSG = '操作太频繁，请稍后再试';
const FROZEN_MSG = '尝试次数过多，请稍后重试';
const DAILY_MSG = '今日请求量已满，请明天再试';

// ---------------- 身份识别 ----------------
function clientIp(req) {
  var v = String((req.headers && (req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'])) || '');
  var ip = v.split(',')[0].trim();
  if (!ip) return '';
  // 去除 IPv6 前缀/端口噪声，仅用于组合 key，不参与真实性校验
  return ip.slice(0, 128);
}

export function clientKeyOf(req) {
  var ip = clientIp(req);
  var device = String((req.headers && (req.headers['x-device-id'] || req.headers['X-Device-Id'])) || '').trim().slice(0, 128);
  if (!device) device = 'no-device';
  return (ip || 'unknown-ip') + '|' + device;
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

// 窗口工具：返回当前窗口起始时间（毫秒）
function winStart(nowMs, winMs) {
  return Math.floor(nowMs / winMs) * winMs;
}

function dayStr(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10); // UTC 自然日
}

// ---------------- Supabase 辅助（与其它 api 保持同一 env 用法） ----------------
function supabaseBase() {
  return String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
}
function restHeaders(json) {
  var h = {
    'apikey': process.env.SUPABASE_SERVICE_KEY || '',
    'Authorization': 'Bearer ' + (process.env.SUPABASE_SERVICE_KEY || '')
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
function supabaseReady() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

// Supabase 不可用降级：标记 + 节流 warn（60 秒最多一次）
var degradeState = { at: 0, mode: false, checkedAt: 0 };
function degradeMode(forceWarn) {
  var now = Date.now();
  if (now - degradeState.checkedAt > 60000) {
    degradeState.checkedAt = now;
    degradeState.mode = false; // 周期性允许重试 Supabase，成功后自动恢复
  }
  if (!forceWarn) return degradeState.mode;
  if (now - degradeState.at > 60000) {
    degradeState.at = now;
    console.warn('[rate-limit] Supabase 不可用，已降级为进程内内存近似限流（fail-open，不阻断服务）');
  }
}

async function sbGet(key) {
  var base = supabaseBase();
  var url = base + '/rest/v1/' + TABLE + '?select=bucket_key,count,frozen_until&bucket_key=eq.' + encodeURIComponent(key);
  var resp = await fetch(url, { headers: restHeaders(false), signal: AbortSignal.timeout(2500) });
  if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
  var rows = await resp.json();
  return (Array.isArray(rows) && rows.length) ? rows[0] : null;
}

async function sbUpsert(key, fields) {
  var base = supabaseBase();
  var url = base + '/rest/v1/' + TABLE + '?on_conflict=bucket_key';
  var payload = Object.assign({ bucket_key: key, updated_at: new Date().toISOString() }, fields);
  var resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(restHeaders(true), { 'Prefer': 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2500)
  });
  if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
  var rows = await resp.json();
  return (Array.isArray(rows) && rows.length) ? rows[0] : null;
}

// ---------------- 内存近似（表不可用降级用） ----------------
var mem = new Map(); // key -> { count, win, updatedAt, frozenUntil }
function memIncr(key, windowMs, extra) {
  var now = Date.now();
  var win = windowMs ? winStart(now, windowMs) : 0;
  var rec = mem.get(key);
  if (!rec) {
    rec = { count: 0, win: win, updatedAt: now, frozenUntil: 0 };
    mem.set(key, rec);
  }
  if (windowMs && rec.win !== win) {
    rec.win = win;
    rec.count = 0;
  }
  rec.count += 1;
  rec.updatedAt = now;
  if (extra && extra.frozenUntil !== undefined) rec.frozenUntil = extra.frozenUntil;
  // 惰性清理过旧记录，控制内存
  if (mem.size > 20000) {
    var cutoff = now - MEM_TTL_MS;
    for (var it of mem) {
      if (it[1].updatedAt < cutoff) mem.delete(it[0]);
    }
  }
  return rec;
}

// ---------------- 限流主体 ----------------
// 窗口定义：(winType, windowMs, limit)
function windowsFor(kind) {
  if (kind === 'ai') {
    return [
      { winType: 'minute', windowMs: 60 * 1000, limit: LIMITS.ai.minute },
      { winType: 'hour', windowMs: 60 * 60 * 1000, limit: LIMITS.ai.hour }
    ];
  }
  if (kind === 'admin') {
    return [{ winType: 'minute', windowMs: 60 * 1000, limit: LIMITS.admin.minute }];
  }
  // read
  return [{ winType: 'minute', windowMs: 60 * 1000, limit: LIMITS.read.minute }];
}

// kind: 'ai' | 'admin' | 'read'
// 返回 { ok:true } 或 { ok:false, code:'RATE_LIMITED'|'DAILY_LIMIT' }
export async function limit(req, kind) {
  var identity = clientKeyOf(req);
  var identHash = shortHash(identity);
  var now = Date.now();
  var windows = windowsFor(kind);
  var plans = [];
  windows.forEach(function (w) {
    var ws = winStart(now, w.windowMs);
    plans.push({
      key: kind + ':w:' + identHash + ':' + ws,
      winType: w.winType,
      windowStart: ws,
      limit: w.limit
    });
  });
  var isDaily = kind === 'ai';
  var dailyKey = isDaily ? 'ai:d:' + dayStr(now) : '';
  var dailyPlan = isDaily ? { key: dailyKey, limit: DAILY_LIMIT } : null;

  // 1) Supabase 计数（可用时）
  if (supabaseReady() && !degradeMode(false)) {
    try {
      var allKeys = plans.map(function (p) { return p.key; });
      if (dailyPlan) allKeys.push(dailyPlan.key);
      var url = supabaseBase() + '/rest/v1/' + TABLE +
        '?select=bucket_key,count&bucket_key=in.(' + allKeys.map(encodeURIComponent).join(',') + ')';
      var resp = await fetch(url, { headers: restHeaders(false), signal: AbortSignal.timeout(2500) });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      var rows = await resp.json();
      var byKey = {};
      (Array.isArray(rows) ? rows : []).forEach(function (r) { byKey[r.bucket_key] = r; });

      // 判断
      for (var i = 0; i < plans.length; i++) {
        var row = byKey[plans[i].key];
        if (row && Number(row.count || 0) >= plans[i].limit) {
          return { ok: false, code: 'RATE_LIMITED' };
        }
      }
      if (dailyPlan) {
        var drow = byKey[dailyPlan.key];
        if (drow && Number(drow.count || 0) >= dailyPlan.limit) {
          return { ok: false, code: 'DAILY_LIMIT' };
        }
      }
      // 2) 全部通过 → 逐窗口 +1（基于刚读到的值，窗口内近似计数）
      for (var j = 0; j < plans.length; j++) {
        var old = byKey[plans[j].key];
        var fields = {
          kind: kind,
          identity: identity.slice(0, 300),
          window_type: plans[j].winType,
          window_start: plans[j].windowStart,
          count: (old ? Number(old.count || 0) : 0) + 1
        };
        await sbUpsert(plans[j].key, fields);
      }
      if (dailyPlan) {
        var dold = byKey[dailyPlan.key];
        await sbUpsert(dailyPlan.key, {
          kind: 'ai',
          identity: 'daily',
          window_type: 'day',
          window_start: 0,
          count: (dold ? Number(dold.count || 0) : 0) + 1
        });
      }
      return { ok: true };
    } catch (e) {
      // Supabase 不可用：fail-open 降级到内存近似，不禁访
      degradeMode(true);
    }
  }

  // 3) 内存近似（表不可用 / 未配置 env）
  var memLimit = 0;
  for (var k = 0; k < plans.length; k++) {
    memLimit = Math.max(memLimit, plans[k].limit);
  }
  if (isDaily) {
    var dailyRec = memIncr(dailyPlan.key, 0, null);
    if (dailyRec.count > dailyPlan.limit) {
      return { ok: false, code: 'DAILY_LIMIT' };
    }
  }
  for (var m = 0; m < plans.length; m++) {
    var rec = memIncr(plans[m].key, windows[m].windowMs, null);
    if (rec.count > plans[m].limit) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
  }
  return { ok: true };
}

// ---------------- 管理密钥失败冻结 ----------------
function freezeKeyForIp(req) {
  var ip = clientIp(req) || 'unknown-ip';
  return 'fail:ip:' + shortHash(ip);
}

// 是否处于冻结：{ ok:true }（未冻结/放行）或 { ok:false, code:'FROZEN' }
export async function freezeCheck(req) {
  var key = freezeKeyForIp(req);
  if (supabaseReady() && !degradeMode(false)) {
    try {
      var row = await sbGet(key);
      if (row && Number(row.frozen_until || 0) > Date.now()) {
        return { ok: false, code: 'FROZEN' };
      }
      return { ok: true };
    } catch (e) {
      degradeMode(true);
    }
  }
  var rec = mem.get(key);
  if (rec && Number(rec.frozenUntil || 0) > Date.now()) {
    return { ok: false, code: 'FROZEN' };
  }
  return { ok: true };
}

// 记录一次密钥失败：连续达到 maxFail → 冻结 freezeMs。返回 { frozen:boolean }
export async function recordKeyFail(req) {
  var key = freezeKeyForIp(req);
  var now = Date.now();
  var frozen = false;
  if (supabaseReady() && !degradeMode(false)) {
    try {
      var row = await sbGet(key);
      var count = 0;
      if (row && Number(row.frozen_until || 0) > now) {
        // 冻结期内不应继续放行到这里（handler 应先 freezeCheck）；若到此处说明已解冻窗口，重新计数
        count = 0;
      } else if (row) {
        count = Number(row.count || 0);
      }
      count += 1;
      var fields = {
        kind: 'fail',
        identity: 'ip',
        window_type: 'freeze',
        window_start: now,
        count: count,
        frozen_until: 0
      };
      if (count >= FAIL_FREEZE.maxFail) {
        frozen = true;
        fields.frozen_until = now + FAIL_FREEZE.freezeMs;
        fields.count = 0; // 冻结期内 count 归零，解冻后重新累计
      }
      await sbUpsert(key, fields);
      return { frozen: frozen };
    } catch (e) {
      degradeMode(true);
    }
  }
  var rec = memIncr(key, 0, null);
  if (rec.count >= FAIL_FREEZE.maxFail) {
    frozen = true;
    rec.count = 0;
    rec.frozenUntil = now + FAIL_FREEZE.freezeMs;
  }
  return { frozen: frozen };
}

// ---------------- 统一 429 响应 ----------------
export function deny(res, code) {
  var msg = RATE_MSG;
  if (code === 'FROZEN') msg = FROZEN_MSG;
  else if (code === 'DAILY_LIMIT') msg = DAILY_MSG;
  res.status(429).json({ ok: false, code: code || 'RATE_LIMITED', error: msg });
}

// 仅供内部参考：对外占位，避免 Vercel 无 default export 构建异常
export default async function handler(req, res) {
  res.status(404).json({ error: 'Not Found' });
}
