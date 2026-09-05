// Vercel Serverless Function: /api/translate
// 职责：答辩助手「中译英」翻译接口（中文 → 正式英文学术/答辩表达）
// 密钥只存在于服务端环境变量，绝不进入前端代码。

const TRANSLATE_SYSTEM_PROMPT =
  '你是一位学术答辩翻译助手。用户会输入中文句子，请将其翻译为正式、地道的英文学术/答辩表达。' +
  '要求：\n' +
  '1. 只输出一个 JSON 对象，不要输出任何其他文字。\n' +
  '2. JSON 结构：{"translation": "翻译后的英文", "notes": "可选：对术语选择、句式处理或学术惯例的简短中文说明；若无要说明的则为空字符串"}\n' +
  '3. 严格忠实原意：不增删用户表达的观点，不擅自改写事实，不添加原文没有的内容。\n' +
  '4. 译文使用正式学术/答辩语气（书面、礼貌、准确），适当处理中英文句式差异，保留专业术语准确性。\n' +
  '5. translation 输出纯英文；notes 用中文，若没有要说明的必须为空字符串。';

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
    max_tokens: 1200
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
    res.status(400).json({ ok: false, error: 'text 参数不能为空' });
    return;
  }
  if (text.length > 600) {
    res.status(400).json({ ok: false, error: '内容过长，请控制在 600 字以内' });
    return;
  }

  var apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(503).json({ ok: false, error: '服务端未配置翻译模型（DEEPSEEK_API_KEY），请联系站长启用' });
    return;
  }

  try {
    var content = await callLLM(TRANSLATE_SYSTEM_PROMPT, '用户输入（中文）：\n' + text, true);
    var parsed = extractJSON(content);
    if (!parsed || !parsed.translation) throw new Error('模型输出无法解析为 JSON');
    res.status(200).json({
      ok: true,
      translation: String(parsed.translation).trim(),
      notes: parsed.notes ? String(parsed.notes).trim() : ''
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: '翻译服务暂不可用：' + String(err.message || err) + '，请稍后重试'
    });
  }
}
