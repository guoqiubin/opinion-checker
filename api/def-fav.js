// Vercel Serverless Function: /api/def-fav
// 职责：答辩助手「中英精选墙」读写接口（站长收藏的中英双语句子）
//   GET    /api/def-fav?limit=&offset=         公开读，按 created_at desc 分页
//   POST   /api/def-fav                         站长收藏（X-Manage-Key 校验）
//   DELETE /api/def-fav?id=xxx                  站长删除（X-Manage-Key 校验）
// 密钥/凭据只存在于服务端环境变量，绝不进入前端代码。
import crypto from 'crypto';

const TABLE = 'defense_favorites';

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

  // GET：公开读取中英精选列表
  if (req.method === 'GET') {
    const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const url = base + '/rest/v1/' + TABLE +
      '?select=id,zh,en,notes,created_at' +
      '&status=eq.published&order=created_at.desc&limit=' + limit + '&offset=' + offset;
    try {
      const resp = await fetch(url, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
      });
      if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
      const rows = await resp.json();
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

    // POST：站长收藏（中英双译）
    const body = req.body || {};
    const zh = String(body.zh || '').trim();
    const en = String(body.en || '').trim();
    if (!zh) return jsonError(res, 400, 'zh 不能为空');
    if (!en) return jsonError(res, 400, 'en 不能为空');
    if (zh.length > 600) return jsonError(res, 400, '中文过长，请控制在 600 字以内');
    if (en.length > 3000) return jsonError(res, 400, '译文过长，请控制在 3000 字以内');

    const record = {
      zh: zh,
      en: en,
      notes: body.notes ? String(body.notes).slice(0, 500) : null
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
      return jsonError(res, 500, '收藏失败：' + String(err.message || err));
    }
  }

  return jsonError(res, 405, 'Method Not Allowed');
}
