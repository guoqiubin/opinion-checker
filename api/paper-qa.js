// Vercel Serverless Function: /api/paper-qa
// 职责：论文小助手 Q&A 问答信息流「公开只读」接口（极简版：无分类）
//   GET /api/paper-qa
//       仅返回 published=true，按 sort, id 升序
// 返回：{ ok: true, total: n, items: [{id, question, answer, updated_at}] }
// 密钥/凭据只存在于服务端环境变量，绝不进入前端代码。
import * as guard from './_guard.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: '服务端未配置 Supabase 环境变量' });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  // 风控：宽松只读限流（同身份 120 次/分钟），仅挡脚本连发
  const gl = await guard.limit(req, 'read');
  if (!gl.ok) return guard.deny(res, gl.code);

  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const authHeaders = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
  };
  const TABLE = 'paper_qa';

  const url = base + '/rest/v1/' + TABLE +
    '?select=id,question,answer,updated_at' +
    '&published=eq.true' +
    '&order=sort.asc,id.asc';

  try {
    const resp = await fetch(url, { headers: authHeaders });
    if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
    const rows = await resp.json();
    const items = Array.isArray(rows) ? rows : [];
    return res.status(200).json({ ok: true, total: items.length, items: items });
  } catch (err) {
    const message = String((err && err.message) || err || '未知错误');
    if (message === 'DB_HTTP_404') {
      return res.status(503).json({ error: '论文问答服务尚未完成数据库初始化' });
    }
    return res.status(500).json({ error: '查询失败：' + message });
  }
}
