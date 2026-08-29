// Vercel Serverless Function: /api/distill
// 职责：调用 LLM 将口语化 / 散乱的小作文提炼为清晰、可验证的核心观点（观点提炼）
// 密钥只存在于服务端环境变量，绝不进入前端代码。

const DISTILL_SYSTEM_PROMPT =
  '你是一位观点提炼助手。用户会输入一段口语化、散乱、可能包含举例、对比和情绪的表达（小作文），请从中提炼出真正可验证的核心观点。' +
  '要求：\n' +
  '1. 只输出一个 JSON 对象，不要输出任何其他文字。\n' +
  '2. JSON 结构：{"statement": "提炼后的核心观点陈述（一句话或两三句话，简洁、客观、可验证，供后续学术判断直接使用）", "points": ["2-5条核心要点，保留用户原始立场与关键信息，不添加新观点"]}\n' +
  '3. 严格保留原意：不增删用户的立场，不替用户下结论，不评判观点对错，不补写用户没说的内容。\n' +
  '4. 去除口语化冗余、举例细节、情绪化表达，保留论述骨架；若原文包含多个论断，按最核心的论断提炼，其余放入 points。\n' +
  '5. statement 使用客观陈述句，避免"我觉得""可能吧"等含糊措辞，让后续检索可执行。';

function extractJSON(text) {
  try { return JSON.parse(text); } catch (e) {}
  var m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e2) {}
  }
  return null;
}

function callLLM(systemPrompt, userContent, tryJson) {
  var apiUrl = process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions';
  var apiKey = process.env.DEEPSEEK_API_KEY;
  var model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  var body = {
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.2,
    max_tokens: 800
  };
  if (tryJson) body.response_format = { type: 'json_object' };
  return fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify(body)
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        throw new Error('LLM API 返回 ' + res.status + ': ' + String(t).slice(0, 300));
      });
    }
    return res.json();
  }).then(function (data) {
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('模型返回为空');
    return content;
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  var text = '';
  try {
    text = String((req.body && req.body.text) || '').trim();
  } catch (e) {}
  if (!text) {
    res.status(400).json({ error: 'text 参数不能为空' });
    return;
  }
  if (text.length > 600) {
    res.status(400).json({ error: '内容过长，请控制在 600 字以内' });
    return;
  }

  var apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 未配置模型：降级返回原文，前端提示后直接走关键词检测
    res.status(200).json({
      mode: 'keyword',
      statement: text,
      points: [],
      message: '服务端未配置 AI 模型，无法提炼观点。'
    });
    return;
  }

  try {
    var content = await callLLM(DISTILL_SYSTEM_PROMPT, '用户输入：\n' + text, true);
    var parsed = extractJSON(content);
    if (!parsed || !parsed.statement) throw new Error('模型输出无法解析为 JSON');
    var points = Array.isArray(parsed.points)
      ? parsed.points.map(String).filter(Boolean).slice(0, 5)
      : [];
    res.status(200).json({
      mode: 'llm',
      statement: String(parsed.statement).trim(),
      points: points
    });
  } catch (err) {
    res.status(200).json({
      mode: 'keyword',
      statement: text,
      points: [],
      message: '观点提炼失败：' + String(err.message || err) + '，已退回原文。'
    });
  }
}
