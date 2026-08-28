// Vercel Serverless Function: /api/check
// 职责：1) 调用 LLM 判断观点是否有理论支持（读取服务端环境变量 DEEPSEEK_API_KEY）
//       2) 用提炼出的学术概念检索 Semantic Scholar / Crossref
// 注意：API Key 只存在于服务端环境变量，绝不进入前端代码。

const JUDGE_SYSTEM_PROMPT =
  '你是一位严谨的学术评审助手。用户会给出一个观点（可能带有个人判断）。' +
  '你的任务是判断该观点是否存在「理论支持 / 学术支持」：即该观点是否有对应的学术理论、实证研究、同行评审文献或公认科学结论支撑。' +
  '要求：\n' +
  '1. 只输出一个 JSON 对象，不要输出任何其他文字。\n' +
  '2. JSON 结构：{"level": "high" 或 "medium" 或 "low", "summary": "一句话结论（中文）", "reasoning": "理由说明（中文，2-3句话，具体说明依据了什么理论/研究/证据，以及为什么给出该等级）", "concepts": ["3-8个学术检索关键词（优先英文，其次中文，必须是该观点对应的专业学术概念）"], "search_query": "一条最合适的学术检索查询串（英文优先）"}\n' +
  '3. 等级定义：\n' +
  '   - high：存在明确、直接、较强的理论/研究支持，观点与公认学术结论高度一致；\n' +
  '   - medium：存在部分、间接或近似支持，观点与某些理论/研究相关，但证据不完全充分或有争议；\n' +
  '   - low：缺乏直接的学术支持、没有实证依据、仅为个人臆断或常识性表述。\n' +
  '4. reasoning 必须具体：指明相关理论名称、研究领域或证据类型，并说明支持程度与局限。\n' +
  '5. concepts 必须精确对应观点背后的学术概念，例如观点是"人口密度过高会导致社会冲突"，concepts 应包含 "population density", "social conflict", "overcrowding" 等，绝不能是原文的词频词。\n' +
  '6. 若观点本身模糊或混合多个论断，按最核心的论断判断。';

const STOP_WORDS = new Set([
  '的','了','和','与','或','是','在','我','你','他','她','它','们','这','那','就','都','而','及','把','被','让','向','从','对','于','给','用','以','为','等','中','上','下','不','也','很','更','最','有','没有','会','要','能','可','将','正','但','却','并','其','之','一个','一种','这个','那个','这些','那些','因为','所以','如果','虽然','但是','以及','可以','认为','观点','提出','我们','大家','应该','需要','随着','由于','通过','进行','成为','可能','就是','只是','还是','或者','其中','目前','现在','未来','已经','开始','相关','问题','方面','领域','发展','影响','作用','意义','理论','支持','研究','文献'
]);
const SKIP_PATTERN = /^[\d\s.,!?;:"'，。！？；：、""''（）()\[\]【】\-—~～·…%％#@&*+/\\=<>《》|^$]+$/;

function extractKeywords(text) {
  var picked = [];
  var freq = {};
  var chunks = text.match(/[\u4e00-\u9fa5A-Za-z]+/g) || [];
  chunks.forEach(function (chunk) {
    // 英文/数字长词整体作为候选
    if (/[A-Za-z]{2,}/.test(chunk)) {
      var kw = chunk.toLowerCase();
      if (kw.length >= 3 && kw.length <= 24) freq[kw] = (freq[kw] || 0) + 1;
      return;
    }
    // 中文：2~6 字滑窗提取
    for (var n = 6; n >= 2; n--) {
      for (var i = 0; i + n <= chunk.length; i++) {
        var w = chunk.substr(i, n);
        if (STOP_WORDS.has(w)) continue;
        freq[w] = (freq[w] || 0) + 1;
      }
    }
  });
  var sorted = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
  // 去重叠：优先保留更长且不互相包含的片段
  sorted.forEach(function (w) {
    if (picked.length >= 8) return;
    var covered = picked.some(function (p) { return p.indexOf(w) >= 0 || w.indexOf(p) >= 0; });
    if (!covered) picked.push(w);
  });
  if (picked.length === 0) {
    var words = text.match(/[\u4e00-\u9fa5A-Za-z]{2,}/g) || [];
    picked = words.slice(0, 5);
  }
  return picked;
}

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

// 信源等级体系：一级=国际顶刊，二级=正规学术期刊/知名出版社，三级=预印本/其他
const TOP_JOURNALS = [
  'nature', 'science', 'cell', 'proceedings of the national academy of sciences', 'pnas',
  'the lancet', 'lancet', 'new england journal of medicine', 'nejm', 'jama',
  'bmj', 'british medical journal', 'psychological review', 'psychological science',
  'psychological bulletin', 'american psychologist', 'nature neuroscience',
  'nature human behaviour', 'nature mental health', 'nature reviews',
  'trends in cognitive sciences', 'trends in neurosciences', 'annual review of psychology',
  'annual review of neuroscience', 'behavioral and brain sciences', 'neuron', 'brain',
  'journal of experimental psychology', 'journal of personality and social psychology',
  'journal of the american medical association', 'american journal of psychiatry',
  'cognitive psychology', 'current directions in psychological science',
  'journal of memory and language', 'psychonomic bulletin', 'perspectives on psychological science',
  'lancet neurology', 'lancet psychiatry', 'nature medicine', 'nature communications',
  'science advances', 'american economic review', 'journal of finance', 'quarterly journal of economics'
];
const MAJOR_PUBLISHERS = [
  'elsevier', 'springer', 'wiley', 'sage', 'oxford university press', 'cambridge university press',
  'taylor & francis', 'ieee', 'acm', 'american psychological association', 'apa',
  'lippincott', 'wolters kluwer', 'emerald', 'de gruyter', 'annual reviews',
  'cell press', 'bmc', 'plos', 'acs', 'royal society', 'iop publishing', 'mdpi',
  'frontiers media', 'nature portfolio', 'guilford', 'psychology press', 'routledge'
];

function rateSource(item) {
  var venue = String(item.venue || '').toLowerCase().replace(/[^a-z0-9&\s]/g, ' ').replace(/\s+/g, ' ').trim();
  var publisher = String(item.publisher || '').toLowerCase();
  for (var i = 0; i < TOP_JOURNALS.length; i++) {
    if (venue.indexOf(TOP_JOURNALS[i]) >= 0) { item.level = 1; return item; }
  }
  for (var j = 0; j < MAJOR_PUBLISHERS.length; j++) {
    if (publisher.indexOf(MAJOR_PUBLISHERS[j]) >= 0 || venue.indexOf(MAJOR_PUBLISHERS[j]) >= 0) {
      item.level = 2;
      return item;
    }
  }
  if (venue) { item.level = 2; return item; }
  item.level = 3;
  return item;
}

function searchOpenAlex(query) {
  var url = 'https://api.openalex.org/works?search=' + encodeURIComponent(query) +
    '&per-page=10&select=id,display_name,publication_year,authorships,primary_location,cited_by_count,doi,type';
  return fetch(url, {
    headers: { 'Accept': 'application/json' }
  }).then(function (res) {
    if (!res.ok) throw new Error('OA_HTTP_' + res.status);
    return res.json();
  }).then(function (data) {
    return (data.results || []).map(function (w) {
      var venue = null;
      var publisher = null;
      if (w.primary_location && w.primary_location.source) {
        venue = w.primary_location.source.display_name || null;
        publisher = w.primary_location.source.host_organization_name || null;
      }
      return {
        title: w.display_name,
        authors: (w.authorships || []).map(function (a) { return a.author && a.author.display_name; }).filter(Boolean),
        year: w.publication_year,
        venue: venue,
        publisher: publisher,
        doi: w.doi ? w.doi.replace('https://doi.org/', '') : null,
        url: w.doi || null,
        cited_by_count: w.cited_by_count || 0,
        api: 'openalex'
      };
    });
  });
}

function searchSemanticScholar(query) {
  var url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' +
    encodeURIComponent(query) + '&limit=10&fields=title,authors,year,venue,externalIds,url,abstract';
  return fetch(url, {
    headers: { 'Accept': 'application/json' }
  }).then(function (res) {
    if (res.status === 429) throw new Error('RATE_LIMIT');
    if (!res.ok) throw new Error('S2_HTTP_' + res.status);
    return res.json();
  }).then(function (data) {
    return (data.data || []).map(function (p) {
      return {
        title: p.title,
        authors: (p.authors || []).map(function (a) { return a.name; }),
        year: p.year,
        venue: p.venue,
        doi: (p.externalIds && p.externalIds.DOI) || null,
        url: p.url || (p.externalIds && p.externalIds.DOI ? 'https://doi.org/' + p.externalIds.DOI : null),
        api: 'semanticscholar'
      };
    });
  });
}

function searchCrossref(query) {
  var url = 'https://api.crossref.org/works?query=' + encodeURIComponent(query) +
    '&rows=10&select=DOI,title,author,issued,container-title,URL';
  return fetch(url, {
    headers: { 'Accept': 'application/json' }
  }).then(function (res) {
    if (!res.ok) throw new Error('CR_HTTP_' + res.status);
    return res.json();
  }).then(function (data) {
    return (data.message.items || []).map(function (it) {
      var year = null;
      if (it.issued && it.issued['date-parts'] && it.issued['date-parts'][0] && it.issued['date-parts'][0][0]) {
        year = it.issued['date-parts'][0][0];
      }
      return {
        title: (it.title && it.title[0]) || null,
        authors: (it.author || []).map(function (a) {
          return [a.given, a.family].filter(Boolean).join(' ');
        }),
        year: year,
        venue: (it['container-title'] && it['container-title'][0]) || null,
        doi: it.DOI || null,
        url: it.URL || (it.DOI ? 'https://doi.org/' + it.DOI : null),
        api: 'crossref'
      };
    });
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function searchAcademic(query) {
  // 检索链路：OpenAlex（覆盖广、带期刊/出版社信息）→ Semantic Scholar → Crossref
  var items = [];
  var source = 'none';
  try {
    var oa = await searchOpenAlex(query);
    if (oa && oa.length) { items = oa; source = 'openalex'; }
  } catch (e) { /* fallthrough */ }
  if (items.length === 0) {
    try {
      var s2 = await searchSemanticScholar(query);
      if (s2 && s2.length) { items = s2; source = 'semanticscholar'; }
    } catch (e) { /* fallthrough */ }
  }
  if (items.length === 0) {
    try {
      var cr = await searchCrossref(query);
      if (cr && cr.length) { items = cr; source = 'crossref'; }
    } catch (e) { /* fallthrough */ }
  }
  items = items.map(rateSource);
  items.sort(function (a, b) {
    if (a.level !== b.level) return a.level - b.level;
    return (b.cited_by_count || 0) - (a.cited_by_count || 0);
  });
  return { items: items, source: source, query: query };
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
  if (text.length > 5000) {
    res.status(400).json({ error: '观点过长，请控制在 5000 字以内' });
    return;
  }

  var apiKey = process.env.DEEPSEEK_API_KEY;
  var verdict = null;
  var query = '';
  var mode = 'keyword';

  if (apiKey) {
    try {
      var content = await callLLM(JUDGE_SYSTEM_PROMPT, '观点：' + text, true);
      var parsed = extractJSON(content);
      if (!parsed) throw new Error('模型输出无法解析为 JSON');
      verdict = parsed;
      mode = 'llm';
      query = String(verdict.search_query || (verdict.concepts || []).join(' ') || '').trim();
      if (!query && verdict.concepts && verdict.concepts.length) {
        query = verdict.concepts.join(' ');
      }
      if (!query) query = text.slice(0, 200);
    } catch (err) {
      verdict = { error: String(err.message || err) };
      mode = 'keyword';
      var kws = extractKeywords(text);
      query = text.slice(0, 150);
      verdict = {
        level: null,
        has_support: null,
        summary: 'AI 判断暂时不可用，以下为关键词检索结果，仅供粗略参考。',
        reasoning: '模型调用失败：' + String(err.message || err),
        concepts: kws
      };
    }
  } else {
    var kws2 = extractKeywords(text);
    query = text.slice(0, 150);
    verdict = {
      level: null,
      has_support: null,
      summary: '服务端未配置 AI 模型，以下为关键词检索结果，仅供粗略参考。',
      reasoning: '管理员尚未在服务端配置模型密钥，无法给出支持度判断；配置后可自动启用 AI 语义判断与高/中/低分级。',
      concepts: kws2
    };
  }

  try {
    var result = await searchAcademic(query);
    res.status(200).json({
      mode: mode,
      verdict: verdict,
      results: result.items,
      source: result.source,
      query: result.query
    });
  } catch (err) {
    res.status(200).json({
      mode: mode,
      verdict: verdict,
      results: [],
      source: 'none',
      query: query,
      error: String(err.message || err)
    });
  }
}
