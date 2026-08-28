# Opinion Checker 观点理论支持检测器

输入你的观点，AI 先理解语义并判断是否存在学术理论支持，再检索学术文献给出分级信源。妈妈再也不用担心我胡说八道了。

## 功能特性

- 富文本观点输入：支持加粗、斜体、列表等基础排版
- AI 语义判断：调用大模型提炼学术概念与检索词，而非简单词频匹配
- 支持度三档分级：高 / 中 / 低，附理由说明
- 学术信源检索：OpenAlex → Semantic Scholar → Crossref 三级降级链路
- 信源等级体系：
  - 一级 · 顶刊：Nature / Science / Cell / PNAS / Lancet / NEJM / Psychological Review 等 40+ 国际顶刊名单
  - 二级 · 期刊：正规学术期刊或知名出版社（Elsevier / Springer / Wiley / APA 等）
  - 三级 · 其他：预印本 / 无期刊归属来源
- 信源按等级优先 + 引用数排序，支持跳转原文 / DOI / Google Scholar
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
│   └── check.js        # Vercel Serverless 函数：LLM 判断 + 学术检索
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
| `DEEPSEEK_API_KEY` | 是 | DeepSeek 平台创建的 API Key（platform.deepseek.com → API keys） |
| `LLM_API_URL` | 否 | 默认 `https://api.deepseek.com/v1/chat/completions` |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |

密钥仅存于服务端环境变量，前端不包含任何模型设置区与密钥逻辑，访客零配置。

### 3. 本地开发

```bash
vercel dev    # 本地启动，访问 http://localhost:3000
```

## API 说明

`POST /api/check`

请求：

```json
{ "text": "感觉是一切心理现象的基础" }
```

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

## 免责声明

本项目仅用于学术观点辅助验证，检索结果来自公开学术数据库，不构成专业意见。观点判断由大模型生成，可能存在偏差，请以原始文献为准。

## License

MIT
