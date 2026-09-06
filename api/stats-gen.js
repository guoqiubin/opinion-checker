// Vercel Serverless Function: /api/stats-gen
// 职责：统计学工具「AI 生成题目」接口
//   依据 工具(Jamovi) × 场景模块 × 细分方法 生成：模拟研究题 + 变量表 + 20~60 行模拟数据集
//   + APA 数值结果 + 中/英双语解读（interpretation），供前端导出 Excel 与查看数据分析。
// 密钥只存在于服务端环境变量，绝不进入前端代码。
// 范式复刻：api/translate.js（CORS/OPTIONS/POST 校验/callLLM/extractJSON/503/502）。

// ---------------- 白名单：与前端 STS_MODULES 保持一致（8 大主场景全量细分） ----------------
// 合法取值：tool ∈ { jamovi, spss }（spss 为预留，后端仍接受但前端不可达）
var STS_ALLOWED = {
  jamovi: {
    exploration: ['descriptives', 'reliability'],
    ttest: ['onesample', 'independent', 'paired', 'mannwhitney', 'wilcoxon'],
    anova: ['oneway', 'anova', 'rm', 'ancova', 'mancova', 'kruskal', 'friedman'],
    regression: ['correlation', 'linear', 'multiple', 'logistic'],
    frequencies: ['binomial', 'multinomial', 'contingency', 'loglinear'],
    factor: ['pca', 'efa', 'cfa'],
    chisq: ['gof', 'independence'],
    sem: ['sem', 'sem-multigroup']
  },
  spss: {}
};

var STS_METHOD_EN = {
  // Exploration
  descriptives: 'Descriptives',
  reliability: 'Reliability Analysis',
  // T-Tests
  onesample: 'One Sample T-Test',
  independent: 'Independent Samples T-Test',
  paired: 'Paired Samples T-Test',
  mannwhitney: "Mann-Whitney U Test",
  wilcoxon: 'Wilcoxon Signed-Rank Test',
  // ANOVA
  oneway: 'One-Way ANOVA',
  anova: 'ANOVA (Factorial)',
  rm: 'Repeated Measures ANOVA',
  ancova: 'ANCOVA',
  mancova: 'MANCOVA',
  kruskal: 'Kruskal-Wallis Test',
  friedman: 'Friedman Test',
  // Regression
  correlation: 'Correlation (Pearson / Spearman)',
  linear: 'Linear Regression',
  multiple: 'Multiple Linear Regression',
  logistic: 'Logistic Regression',
  // Frequencies
  binomial: 'Binomial Test',
  multinomial: 'Multinomial Test',
  contingency: 'Contingency Tables',
  loglinear: 'Log-Linear Regression',
  // Factor
  pca: 'Principal Component Analysis',
  efa: 'Exploratory Factor Analysis',
  cfa: 'Confirmatory Factor Analysis',
  // Chi² Tools
  gof: 'Chi-Square Goodness of Fit',
  independence: 'Chi-Square Test of Independence',
  // SEM
  sem: 'Structural Equation Modeling (SEM)',
  'sem-multigroup': 'Multigroup SEM'
};

var STS_MODULE_EN = {
  exploration: 'Exploration',
  ttest: 'T-Tests',
  anova: 'ANOVA',
  regression: 'Regression',
  frequencies: 'Frequencies',
  factor: 'Factor',
  chisq: 'Chi\u00B2 Tools',
  sem: 'SEM'
};

function buildSystemPrompt(tool, module, method) {
  var methodEn = STS_METHOD_EN[method] || method;
  var moduleEn = STS_MODULE_EN[module] || module;
  return [
    '你是一位面向心理学硕博生的统计学出题助手，负责生成结构化的模拟研究题与配套模拟数据集，用于统计软件（Jamovi）操作练习。',
    '要求：',
    '1. 只输出一个 JSON 对象，不要输出任何其他文字或 Markdown。',
    '2. JSON 结构固定如下：',
    '{"question":{"title":"题目短标题（中文）","scenario":"题干背景：研究情境描述（中文，2-4 句）","researchDesign":"研究设计说明：被试来源/分组方式/测量变量关系（中文）","variables":[{"name":"变量名","label":"变量中文标签","role":"independent|dependent|covariate","type":"categorical|numeric","scale":"nominal|ordinal|continuous","levels":["分类水平1","分类水平2"]}],"sampleSize":60,"expectedMethod":"正式英文方法名","hypothesis":"研究假设 H1 简述（中文）","apaResult":"APA 格式数值结果（示意）"},"dataset":{"note":"模拟数据由 AI 生成，与 apaResult 趋势保持一致（示意性，供练习导出使用）","variables":[与 question.variables 完全相同的数组，作为导出表头],"data":[[第1行各变量值],[第2行各变量值]]},"interpretation":{"zh":{"summary":"中文解读：方法选择依据与研究结论（≤200 字）","apa":"中文 APA 报告句式","practical":"中文实操/写作提示（≤100 字）"},"en":{"summary":"英文解读（academic English, ≤200 words）","apa":"English APA reporting sentence","practical":"English practical tip (≤100 words)"}}}',
    '3. 工具与场景必须与请求一致：tool=' + tool + '，module=' + moduleEn + '，method=' + methodEn + '。expectedMethod 必须填写该细分方法的正式英文名（即 method 对应的标准统计检验名），不允许替换为其他检验。',
    '4. 变量规范：分组/条件变量名用 group 或 condition（type=categorical、scale=nominal、含 levels 数组）；连续因变量自拟心理学构念名（type=numeric、scale=continuous）；协变量用 covariate。变量数按方法合理设置（t 检验 2 个、单因素方差分析 2 个、重复测量 3+ 个、回归/因子/SEM 适当增多）。',
    '5. 数据集：生成 20-60 行（sampleSize 与 data 行数一致）模拟数据。data 每行为一维数组，元素顺序与 dataset.variables 顺序完全一致；分类列用 levels 中的字符串，数值列用数字。数据分布需与 apaResult 的显著方向大体自洽（如 t 检验显著则两组均值差异方向与 p 值一致），示意即可，不要求精确复算。',
    '6. apaResult 使用标准 APA 格式：按方法选用统计量（t / F / r / \u03C7\u00B2 / z / \u03B2 / factor loading 等），写清自由度、p 值（保留三位小数、去前导零，如 p = .003）与效应量（Cohen\'s d / \u03B7p\u00B2 / Cramer\'s V / R\u00B2 / \u03C9\u00B2 等按方法选用）。',
    '7. interpretation 中英文均需输出：summary 学术语气；apa 为可直接复用的报告句式；practical 为实操提示。不得省略任一段。',
    '8. 所有文本字段禁止使用换行符之外的转义字符问题；JSON 必须是合法可解析的 JSON。'
  ].join('\n');
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
    temperature: 0.4,
    max_tokens: 6000
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

function csvCell(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(variables, data) {
  var header = (variables || []).map(function (v) { return csvCell(v.name); }).join(',');
  var lines = [header];
  (data || []).forEach(function (row) {
    lines.push((row || []).map(csvCell).join(','));
  });
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// 返回规范化/最小化后的题目对象（裁剪异常字段、保证关键字段存在）
function normalizePayload(parsed, tool, module, method) {
  var q = parsed.question && typeof parsed.question === 'object' ? parsed.question : {};
  var ds = parsed.dataset && typeof parsed.dataset === 'object' ? parsed.dataset : {};
  var interp = parsed.interpretation && typeof parsed.interpretation === 'object' ? parsed.interpretation : {};

  var variables = Array.isArray(ds.variables) && ds.variables.length
    ? ds.variables
    : (Array.isArray(q.variables) ? q.variables : []);
  var data = Array.isArray(ds.data) ? ds.data : [];
  // 数据行数与变量数不一致时，宁可裁剪也不让导出坏表
  var maxCol = Math.min(data.length ? Math.max.apply(null, data.map(function (r) { return r.length; })) : 0, variables.length);
  var cleanRows = data.map(function (row) {
    var arr = Array.isArray(row) ? row : [];
    return arr.slice(0, maxCol);
  }).slice(0, 60);

  var question = {
    id: 'st-' + tool + '-' + module + '-' + method + '-' + Date.now().toString(36),
    title: String(q.title || (STS_MODULE_EN[module] || module) + ' · ' + (STS_METHOD_EN[method] || method)).trim(),
    scenario: String(q.scenario || '').trim() || '（AI 未返回题干背景，请重新生成）',
    researchDesign: String(q.researchDesign || '').trim(),
    variables: variables,
    sampleSize: Number(q.sampleSize) || cleanRows.length,
    expectedMethod: String(q.expectedMethod || STS_METHOD_EN[method] || method),
    hypothesis: String(q.hypothesis || '').trim(),
    apaResult: String(q.apaResult || '').trim()
  };
  var dataset = {
    note: '模拟数据由 AI 生成，与 apaResult 趋势保持一致（示意性，仅供统计练习）。导出后可在 Jamovi 中打开练习对应分析。',
    variables: variables,
    data: cleanRows,
    csvText: buildCsv(variables, cleanRows)
  };
  var zh = interp.zh && typeof interp.zh === 'object' ? interp.zh : {};
  var en = interp.en && typeof interp.en === 'object' ? interp.en : {};
  var interpretation = {
    zh: {
      summary: String(zh.summary || '').trim(),
      apa: String(zh.apa || '').trim(),
      practical: String(zh.practical || '').trim()
    },
    en: {
      summary: String(en.summary || '').trim(),
      apa: String(en.apa || '').trim(),
      practical: String(en.practical || '').trim()
    }
  };
  return { question: question, dataset: dataset, interpretation: interpretation };
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

  var tool = String((req.body && req.body.tool) || '').trim().toLowerCase();
  var module = String((req.body && req.body.module) || '').trim().toLowerCase();
  var method = String((req.body && req.body.method) || '').trim().toLowerCase();

  if (!tool || !module || !method) {
    res.status(400).json({ ok: false, error: 'tool/module/method 参数不能为空' });
    return;
  }
  var allowedMethods = STS_ALLOWED[tool] && STS_ALLOWED[tool][module];
  if (!allowedMethods || allowedMethods.indexOf(method) === -1) {
    res.status(400).json({ ok: false, error: '不支持的组合：tool=' + tool + ' module=' + module + ' method=' + method });
    return;
  }

  var apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(503).json({ ok: false, error: '服务端未配置题目生成模型（DEEPSEEK_API_KEY），请联系站长启用' });
    return;
  }

  var userContent = [
    '请为以下统计学练习生成一道模拟题：',
    '统计工具：' + tool + '（' + (tool === 'jamovi' ? 'Jamovi' : 'SPSS') + '）',
    '主场景模块：' + (STS_MODULE_EN[module] || module),
    '细分方法：' + (STS_METHOD_EN[method] || method),
    '请按 system prompt 的 JSON 结构输出。'
  ].join('\n');

  try {
    var content = await callLLM(buildSystemPrompt(tool, module, method), userContent, true);
    var parsed = extractJSON(content);
    if (!parsed || !parsed.question) throw new Error('模型输出无法解析为题目 JSON');
    var payload = normalizePayload(parsed, tool, module, method);
    if (!payload.dataset.variables.length || !payload.dataset.data.length) {
      throw new Error('模型输出缺少数据集（variables/data）');
    }
    res.status(200).json({
      ok: true,
      question: payload.question,
      dataset: payload.dataset,
      interpretation: payload.interpretation,
      meta: { tool: tool, module: module, method: method, generatedAt: new Date().toISOString() }
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: '题目生成服务暂不可用：' + String(err.message || err) + '，请稍后重试'
    });
  }
}
