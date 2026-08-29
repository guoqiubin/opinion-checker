// Vercel Serverless Function: /api/featured
// 职责：精选观点展示墙的读写接口
//   GET    /api/featured?limit=&offset=           公开读，按 created_at desc 分页
//   POST   /api/featured                          站长提交（X-Manage-Key 校验）
//   DELETE /api/featured?id=xxx                   站长删除（X-Manage-Key 校验）
// 密钥/凭据只存在于服务端环境变量，绝不进入前端代码。
import crypto from 'crypto';

const TABLE = 'featured_views';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Manage-Key');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return jsonError(res, 500, '服务端未配置 Supabase 环境变量');
  }

  const base = supabaseBase();
  const headers = supabaseHeaders();

  // GET：公开读取精选列表
  if (req.method === 'GET') {
    const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const url = base + '/rest/v1/' + TABLE +
      '?select=id,statement,source_text,verdict,results,mode,lang,pinned,created_at' +
      '&status=eq.published&order=created_at.desc&limit=' + limit + '&offset=' + offset;
    try {
      const resp = await fetch(url, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
      });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      const rows = await resp.json();
      // 兼容历史数据：verdict/results 列可能以 JSON 字符串存储，统一规范化为对象/数组
      rows.forEach(function (row) {
        if (typeof row.verdict === 'string') {
          try { row.verdict = JSON.parse(row.verdict); } catch (e) { row.verdict = null; }
        }
        if (typeof row.results === 'string') {
          try {
            var parsed = JSON.parse(row.results);
            row.results = Array.isArray(parsed) ? parsed : [];
          } catch (e) { row.results = []; }
        }
      });
      return res.status(200).json({ items: rows, limit: limit, offset: offset });
    } catch (err) {
      return jsonError(res, 500, '查询失败：' + String(err.message || err));
    }
  }

  // POST / DELETE：需要管理密钥
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (!isAuthorized(req)) {
      return jsonError(res, 401, '管理密钥无效');
    }
    if (!process.env.FEATURED_MANAGE_KEY) {
      return jsonError(res, 500, '服务端未配置管理密钥');
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!id) return jsonError(res, 400, '缺少 id 参数');
      try {
        const resp = await fetch(base + '/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: headers
        });
        if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
        return res.status(200).json({ ok: true, id: id });
      } catch (err) {
        return jsonError(res, 500, '删除失败：' + String(err.message || err));
      }
    }

    // POST：提交精选
    const body = req.body || {};
    const statement = String(body.statement || '').trim();
    if (!statement) return jsonError(res, 400, 'statement 不能为空');
    if (statement.length > 600) return jsonError(res, 400, '观点过长，请控制在 600 字以内');

    const record = {
      statement: statement,
      source_text: body.source_text ? String(body.source_text).slice(0, 2000) : null,
      verdict: body.verdict || null,
      results: body.results || null,
      mode: body.mode || 'llm',
      lang: body.lang === 'zh' ? 'zh' : 'en',
      pinned: !!body.pinned
    };
    try {
      const resp = await fetch(base + '/rest/v1/' + TABLE, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(record)
      });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      const rows = await resp.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      return res.status(200).json({ ok: true, item: row || null });
    } catch (err) {
      return jsonError(res, 500, '提交失败：' + String(err.message || err));
    }
  }

  return jsonError(res, 405, 'Method Not Allowed');
}
