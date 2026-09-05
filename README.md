# Opinion Checker 观点理论支持检测器

输入你的观点，AI 先理解语义并判断是否存在学术理论支持，再检索学术文献给出分级信源。妈妈再也不用担心我胡说八道了。

## 功能特性

- 富文本观点输入：支持加粗、斜体、列表等基础排版
- 观点提炼：口语化小作文先由 AI 提炼为清晰可验证的核心观点，支持编辑修正后继续检测（≤600 字，实时字数统计）
- 直接检测：已会表达时可跳过提炼，一键直达信源检测
- AI 语义判断：调用大模型提炼学术概念与检索词，而非简单词频匹配
- 支持度三档分级：高 / 中 / 低，附理由说明
- 学术信源检索：OpenAlex → Semantic Scholar → Crossref 三级降级链路
- 中文文献检索：匹配范围收敛到标题 + 摘要（正文出现不算），核心概念词独立精确检索，避免词频噪音
- 信源档案语言筛选：全部 / 英文 / 中文 三态切换，中文自动走中文文献链路
- 信源等级体系：
  - 一级 · 顶刊：Nature / Science / Cell / PNAS / Lancet / NEJM / Psychological Review 等 40+ 国际顶刊名单
  - 二级 · 期刊：正规学术期刊或知名出版社（Elsevier / Springer / Wiley / APA 等）
  - 三级 · 其他：预印本 / 无期刊归属来源
- 信源按等级优先 + 引用数排序，支持跳转原文 / DOI / Google Scholar
- 精选观点墙：站长可把优质「观点 + 判定 + 信源」收录为精选，访客按支持度浏览查看原始结论与来源
- 答辩助手（v1）：中文答辩陈述 → AI 中译英（正式学术/答辩语气，≤600 字，含术语/句式译文说明）
- 中英精选墙：站长将满意的中英双译收藏展示，双语对照供访客学习参考
- 拟物（Skeuomorphism）风格 UI：皮革 / 金属质感、3D 凸起按钮、高光反射
- 更新公告栏：内置版本历史记录

## 技术栈

- 前端：单文件 HTML（原生 JS，无构建步骤）
- 后端：Vercel Serverless Functions（Node.js）
- LLM：DeepSeek API（兼容 OpenAI 协议）
- 学术检索：OpenAlex / Semantic Scholar / Crossref 公开 API

## 目录结构

```
opinion-checker/
├── index.html          # 前端单文件（含样式、交互、公告栏）
├── api/
│   ├── check.js        # Vercel Serverless 函数：LLM 判断 + 学术检索
│   ├── distill.js      # Vercel Serverless 函数：AI 观点提炼
│   ├── translate.js    # Vercel Serverless 函数：答辩助手 AI 中译英
│   ├── featured.js     # Vercel Serverless 函数：精选观点墙读写（Supabase）
│   └── def-fav.js      # Vercel Serverless 函数：中英精选墙读写（Supabase）
├── package.json        # 项目配置与脚本
└── README.md
```

## 快速开始

### 1. 部署到 Vercel

```bash
npm i -g vercel
vercel           # 首次登录并部署（预览环境）
vercel --prod    # 部署生产环境
```

### 2. 配置环境变量

在 Vercel 项目 Settings → Environment Variables 中配置：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | DeepSeek 平台创建的 API Key（platform.deepseek.com → API keys），检测/提炼/翻译共用 |
| `LLM_API_URL` | 否 | 默认 `https://api.deepseek.com/v1/chat/completions` |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |
| `SUPABASE_URL` | 精选墙功能需要 | Supabase 项目 URL，精选观点墙 / 中英精选墙读写依赖 |
| `SUPABASE_SERVICE_KEY` | 精选墙功能需要 | Supabase 服务端密钥（service_role），仅存服务端，前端不接触 |
| `FEATURED_MANAGE_KEY` | 精选墙功能需要 | 站长管理密钥，前端弹窗输入后存 localStorage，收藏 / 删除时经 `X-Manage-Key` 请求头校验 |

模型密钥仅存于服务端环境变量，前端不包含任何模型设置区与密钥逻辑，访客零配置；站长管理密钥由站长主动输入并仅存本机 localStorage，用于精选内容收藏 / 删除。

### 3. 本地开发

```bash
vercel dev    # 本地启动，访问 http://localhost:3000
```

## API 说明

`POST /api/distill`（观点提炼，≤600 字）

请求：

```json
{ "text": "我觉得吧，人口密度到一定程度人就会开始互相伤害，因为东西不够分……" }
```

响应：

```json
{
  "mode": "llm",
  "statement": "当人口密度增加到一定程度时，由于资源有限，人类可能开始自相残杀。",
  "points": ["人口密度增加导致资源有限", "资源有限可能引发人类自相残杀"]
}
```

- 未配置 `DEEPSEEK_API_KEY` 或模型输出异常时自动降级：`mode=keyword`，`statement` 返回原文

`POST /api/check`

请求：

```json
{ "text": "感觉是一切心理现象的基础", "lang": "zh" }
```

- `lang` 可选：`en`（默认，英文文献链路）/ `zh`（中文文献链路，仅匹配标题 + 摘要）
- 中文链路按核心概念词独立精确检索（引号短语），并过滤宽泛概念词，避免正文词频噪音

响应：

```json
{
  "mode": "llm",
  "query": "sensation as foundation of psychological processes cognitive psychology",
  "source": "openalex",
  "verdict": {
    "level": "high",
    "summary": "……",
    "reasoning": "……",
    "concepts": ["sensation", "perception"]
  },
  "results": [
    {
      "title": "……",
      "authors": ["……"],
      "year": 2007,
      "venue": "Behavioral and Brain Sciences",
      "publisher": "Cambridge University Press",
      "doi": "……",
      "level": 1,
      "cited_by_count": 6063,
      "api": "openalex"
    }
  ]
}
```

- 未配置 `DEEPSEEK_API_KEY` 时自动降级为关键词检索模式（mode=keyword），准确率较低
- 学术检索链路：OpenAlex 失败时自动降级 Semantic Scholar，再降级 Crossref

`POST /api/translate`（答辩助手中译英，≤600 字）

请求：

```json
{ "text": "感谢各位老师的提问。本研究的主要贡献在于提出了一种面向低资源场景的轻量级评测方法。" }
```

响应：

```json
{
  "ok": true,
  "translation": "Thank you for your questions. The main contribution of this study is proposing a lightweight evaluation method for low-resource scenarios.",
  "notes": "\"低资源\"译为 low-resource 为该领域通用术语；句式改为英语答辩常用的正式书面表达。"
}
```

- 与提炼/检测共用同一套 DeepSeek 服务端配置；未配置 `DEEPSEEK_API_KEY` 时返回 503 并提示站长启用

`GET /api/def-fav`（中英精选墙公开读，按收藏时间倒序）

```json
{ "items": [ { "id": 1, "zh": "……", "en": "……", "notes": "……", "created_at": "2026-09-05T…" } ], "limit": 20, "offset": 0 }
```

`POST /api/def-fav`（站长收藏中英双译；请求头 `X-Manage-Key` 携带管理密钥，`crypto.timingSafeEqual` 服务端比对）

```json
{ "zh": "中文原句", "en": "英文译文", "notes": "可选译文说明" }
```

`DELETE /api/def-fav?id=1`（站长删除对应收藏）

- 精选观点墙 `featured.js` 与中英精选墙 `def-fav.js` 同构：Supabase REST 直连 + 管理密钥 `timingSafeEqual` 校验，表结构不同（`featured_views` / `defense_favorites`）
- 新表需先在 Supabase SQL Editor 手动执行建表 SQL（`defense_favorites` 字段：`zh` / `en` / `notes` / `status` / `created_at`），具体建表语句见《答辩助手v1实施方案.md》

## 免责声明

本项目仅用于学术观点辅助验证，检索结果来自公开学术数据库，不构成专业意见。观点判断由大模型生成，可能存在偏差，请以原始文献为准。

## License

MIT
