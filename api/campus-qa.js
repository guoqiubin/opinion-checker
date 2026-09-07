// Vercel Serverless Function: /api/campus-qa
// 职责：校招助手（秋招）Q&A 问答信息流「公开只读」接口
//   GET /api/campus-qa
//       可选 ?category=网申          按分类过滤；不传返回全部
//       仅返回 published=true，按 sort, id 升序
// 返回：{ ok: true, total: n, items: [{id, category, question, answer, updated_at}] }
// 密钥/凭据只存在于服务端环境变量，绝不进入前端代码。
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const authHeaders = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
  };
  const TABLE = 'campus_qa';

  // 分类过滤（可选）；不传 category 返回全部已发布问答
  const category = String(req.query.category || '').trim();
  const filter = category
    ? '&category=eq.' + encodeURIComponent(category)
    : '';

  const url = base + '/rest/v1/' + TABLE +
    '?select=id,category,question,answer,updated_at' +
    '&published=eq.true' + filter +
    '&order=sort.asc,id.asc';

  try {
    const resp = await fetch(url, { headers: authHeaders });
    if (!resp.ok) throw new Error('DB_HTTP_' + resp.status);
    const rows = await resp.json();
    const items = Array.isArray(rows) ? rows : [];
    return res.status(200).json({ ok: true, total: items.length, items: items });
  } catch (err) {
    return res.status(500).json({ error: '查询失败：' + String(err.message || err) });
  }
}
