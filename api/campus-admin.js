// Vercel Serverless Function: /api/campus-admin
// 职责：校招助手（秋招）Q&A 问答「后台管理」接口（仅站长可用，X-Manage-Key 校验）
//   管理密钥与精选墙共用同一把 FEATURED_MANAGE_KEY，不新增环境变量
//   统一 POST 动作路由（与新增模块保持独立 API 路径，互不干扰现有精选墙接口）
//     action=list            返回全部问答（含未发布），order: sort asc, id asc
//     action=create          新增问答（category/question/answer，排序自动置尾）
//     action=update          编辑问答（id + category/question/answer）
//     action=delete          删除问答（id）
//     action=toggle_publish  发布/隐藏切换（id + published: true/false）
//     action=move            上移/下移排序（id + dir: up/down）
// 密钥/凭据只存在于服务端环境变量，绝不进入前端代码。
import crypto from 'crypto';
import * as guard from './_guard.js';

const TABLE = 'campus_qa';
const ALLOWED_ACTIONS = ['list', 'create', 'update', 'delete', 'toggle_publish', 'move'];
const CATEGORIES = ['网申', '笔试', '面试', 'offer选择', '其他'];

function supabaseBase() {
  return process.env.SUPABASE_URL.replace(/\/+$/, '');
}

function supabaseHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
    'Prefer': 'return=representation'
  };
}

function timingSafeEqualStr(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function isAuthorized(req) {
  const provided = String(req.headers['x-manage-key'] || req.headers['X-Manage-Key'] || '');
  if (!provided) return false;
  return timingSafeEqualStr(provided, process.env.FEATURED_MANAGE_KEY || '');
}

function jsonError(res, status, message) {
  res.status(status).json({ error: message });
}

function normCategory(value) {
  const c = String(value || '').trim();
  return CATEGORIES.indexOf(c) >= 0 ? c : '其他';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Manage-Key, X-Device-Id');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'Method Not Allowed');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return jsonError(res, 500, '服务端未配置 Supabase 环境变量');
  }
  // 风控：管理写限流（同 IP 30 次/分钟）+ 密钥失败冻结（同 IP 连续失败 5 次冻结 15 分钟）
  const fz = await guard.freezeCheck(req);
  if (!fz.ok) return guard.deny(res, fz.code);
  const gl = await guard.limit(req, 'admin');
  if (!gl.ok) return guard.deny(res, gl.code);
  if (!isAuthorized(req)) {
    await guard.recordKeyFail(req);
    return jsonError(res, 401, '管理密钥无效');
  }
  if (!process.env.FEATURED_MANAGE_KEY) {
    return jsonError(res, 500, '服务端未配置管理密钥');
  }

  const base = supabaseBase();
  const headers = supabaseHeaders();
  const restUrl = base + '/rest/v1/' + TABLE;

  const body = req.body || {};
  let action = String(body.action || '').trim();
  // 兼容方案中简写 toggle 与接口清单 toggle_publish 两种动作名
  if (action === 'toggle') action = 'toggle_publish';
  if (ALLOWED_ACTIONS.indexOf(action) < 0) {
    return jsonError(res, 400, '未知操作：' + action);
  }

  // 读单条辅助（move / delete 时使用）
  async function fetchRows(query, opts) {
    const url = restUrl + (query || '');
    const resp = await fetch(url, opts || { headers: headers });
    if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
    return await resp.json();
  }

  try {
    // ---------- list ----------
    if (action === 'list') {
      const rows = await fetchRows(
        '?select=id,category,question,answer,sort,published,created_at,updated_at&order=sort.asc,id.asc'
      );
      const items = Array.isArray(rows) ? rows : [];
      return res.status(200).json({ ok: true, total: items.length, items: items });
    }

    // ---------- create ----------
    if (action === 'create') {
      const question = String(body.question || '').trim();
      const answer = String(body.answer || '').trim();
      if (!question) return jsonError(res, 400, '问题不能为空');
      if (!answer) return jsonError(res, 400, '答案不能为空');
      if (question.length > 300) return jsonError(res, 400, '问题过长，请控制在 300 字以内');
      if (answer.length > 10000) return jsonError(res, 400, '答案过长，请控制在 10000 字以内');
      const category = normCategory(body.category);

      // 排序置尾：取当前最大 sort + 1
      const tailRows = await fetchRows(
        '?select=sort&order=sort.desc&limit=1',
        { headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY } }
      );
      const maxSort = (Array.isArray(tailRows) && tailRows.length) ? Number(tailRows[0].sort || 0) : 0;

      const record = {
        category: category,
        question: question,
        answer: answer,
        sort: maxSort + 1,
        published: body.published === undefined ? true : !!body.published
      };
      const resp = await fetch(restUrl, { method: 'POST', headers: headers, body: JSON.stringify(record) });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      const rows = await resp.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      return res.status(200).json({ ok: true, item: row || null });
    }

    // ---------- update ----------
    if (action === 'update') {
      const id = String(body.id || '');
      if (!id) return jsonError(res, 400, '缺少 id 参数');
      const question = String(body.question || '').trim();
      const answer = String(body.answer || '').trim();
      if (!question) return jsonError(res, 400, '问题不能为空');
      if (!answer) return jsonError(res, 400, '答案不能为空');
      if (question.length > 300) return jsonError(res, 400, '问题过长，请控制在 300 字以内');
      if (answer.length > 10000) return jsonError(res, 400, '答案过长，请控制在 10000 字以内');
      const category = normCategory(body.category);

      const patch = {
        category: category,
        question: question,
        answer: answer,
        updated_at: new Date().toISOString()
      };
      const resp = await fetch(restUrl + '?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH', headers: headers, body: JSON.stringify(patch)
      });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      const rows = await resp.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      return res.status(200).json({ ok: true, item: row || null });
    }

    // ---------- toggle_publish ----------
    if (action === 'toggle_publish') {
      const id = String(body.id || '');
      if (!id) return jsonError(res, 400, '缺少 id 参数');
      const published = !!body.published;
      const resp = await fetch(restUrl + '?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH', headers: headers, body: JSON.stringify({ published: published })
      });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      const rows = await resp.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      return res.status(200).json({ ok: true, item: row || null });
    }

    // ---------- delete ----------
    if (action === 'delete') {
      const id = String(body.id || '');
      if (!id) return jsonError(res, 400, '缺少 id 参数');
      const resp = await fetch(restUrl + '?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE', headers: headers
      });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      return res.status(200).json({ ok: true, id: id });
    }

    // ---------- move（上移 / 下移：与相邻记录交换 sort） ----------
    if (action === 'move') {
      const id = String(body.id || '');
      const dir = String(body.dir || '') === 'up' ? 'up' : (String(body.dir || '') === 'down' ? 'down' : '');
      if (!id) return jsonError(res, 400, '缺少 id 参数');
      if (!dir) return jsonError(res, 400, 'dir 参数仅支持 up / down');

      const all = await fetchRows('?select=id,sort&order=sort.asc,id.asc');
      const list = Array.isArray(all) ? all : [];
      let idx = -1;
      for (let i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) { idx = i; break; }
      }
      if (idx < 0) return jsonError(res, 404, '未找到该条记录');
      const neighborIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (neighborIdx < 0 || neighborIdx >= list.length) {
        return res.status(200).json({ ok: true, moved: false, reason: dir === 'up' ? '已在最前' : '已在最后' });
      }
      const cur = list[idx];
      const nb = list[neighborIdx];
      const curId = String(cur.id);
      const nbId = String(nb.id);
      // 防御：若 sort 相同（如手工插入），给当前记录一个可区分的新 sort，避免交换无效
      const nbSort = Number(nb.sort || 0);
      const curSort = Number(cur.sort || 0);
      const curNewSort = curSort === nbSort ? (dir === 'up' ? nbSort - 1 : nbSort + 1) : nbSort;
      const nbNewSort = curSort === nbSort ? curSort : curSort;
      const body1 = { sort: curNewSort };
      const body2 = { sort: nbNewSort };
      const r1 = await fetch(restUrl + '?id=eq.' + encodeURIComponent(curId), {
        method: 'PATCH', headers: headers, body: JSON.stringify(body1)
      });
      if (!r1.ok) throw new Error('DB_HTTP_' + r1.status);
      const r2 = await fetch(restUrl + '?id=eq.' + encodeURIComponent(nbId), {
        method: 'PATCH', headers: headers, body: JSON.stringify(body2)
      });
      if (!r2.ok) throw new Error('DB_HTTP_' + r2.status);
      return res.status(200).json({ ok: true, moved: true, id: id, dir: dir });
    }

    return jsonError(res, 400, '未知操作');
  } catch (err) {
    return jsonError(res, 500, '操作失败：' + String(err.message || err));
  }
}
