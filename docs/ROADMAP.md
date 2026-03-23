# wechat-ai Roadmap - 需求分析与调研

> 基于 GitHub 生态调研和技术可行性分析，2026-03-23

## 竞品格局

| 项目 | Stars | 定位 | 与我们的关系 |
|------|-------|------|-------------|
| OpenClaw | 331k | 官方 AI Agent 协议 | 我们基于其 iLink 协议 |
| chatgpt-on-wechat (CowAgent) | 42.4k | 多平台 AI 助理 | 直接竞品，功能全但重 |
| nanobot | 35.6k | 轻量 OpenClaw | 定位相似，轻量路线 |
| wechaty | 22.6k | 微信 SDK | 底层依赖，非直接竞品 |
| wechat-chatgpt | 13.3k | 微信+ChatGPT | 老项目，功能单一 |
| wechatbot-webhook | 2.2k | 微信 Webhook 服务 | **证明 Webhook 是刚需** |
| nexu | 637 | 跨平台桥接 Agent→微信/飞书/Slack/Discord | **证明跨平台桥接有需求** |

**我们的差异化定位：** 纯 TypeScript 轻量中间层，自主实现 iLink 协议，npm 一键安装，7 模型开箱即用 + Claude Agent 模式。

---

## 功能需求分析

### 1. Webhook HTTP 入口

**解决什么问题：** 外部系统（CI/CD、监控、定时任务）无法主动推送消息到微信。

**真实需求证据：**
- wechatbot-webhook 项目 2,168 stars + 30 open issues，**专门做这一件事**就获得了可观关注
- 其描述："用它作为个人通知、AIGC 应用或者 coze、n8n 等自动化工作流的消息节点"
- 这说明开发者确实需要一个简单的 HTTP→微信 的消息通道

**具体场景：**
- GitHub Actions 构建失败 → 微信收到告警
- Grafana/Prometheus 报警 → 微信通知
- 定时脚本跑完 → 微信推送结果
- n8n/Zapier 自动化工作流 → 微信作为最后一环

**实现难度：** 小（加一个 HTTP server，接收 POST 转发到微信渠道）

**优先级：P0** — 成本低、需求已被市场验证、能快速获得开发者用户

---

### 2. 中间件/插件系统

**解决什么问题：** 当前项目是个完整工具，开发者无法在不 fork 代码的情况下挂自己的逻辑。

**真实需求证据：**
- Telegram 生态中 telegraf (16k stars)、grammY (2k stars) 的核心竞争力就是中间件系统
- chatgpt-on-wechat 有插件系统，是其从 4k 涨到 42k stars 的关键转折点
- 所有成功的 bot 框架（Discord.js、Botpress）都有插件/中间件体系

**具体用法：**
```typescript
import { Gateway } from 'wechat-ai'

const gw = new Gateway(config)
gw.use(rateLimitMiddleware)      // 限流
gw.use(keywordFilterMiddleware)  // 敏感词过滤
gw.use(loggerMiddleware)         // 日志记录
gw.on('message', myHandler)      // 自定义处理
```

**实现难度：** 中（需要重新设计 gateway 的消息流，但不影响现有功能）

**优先级：P0** — 这是从"工具"变"中间层"的分水岭，没有这个开发者只能 fork

---

### 3. 所有模型支持工具调用 (Function Calling)

**解决什么问题：** 目前只有 Claude 能当 Agent 执行工具，其他 6 个模型只能纯聊天。

**真实需求证据（调研结论）：**

| 模型 | 支持 FC | OpenAI 兼容 | 支持 tool_choice |
|------|---------|------------|-----------------|
| DeepSeek | Yes | Yes | Yes |
| Qwen | Yes | Yes (compatible-mode) | Yes |
| GLM | Yes | Yes (v4 API) | Yes |
| Gemini | Yes | Yes (via /openai/) | Yes |
| MiniMax | Yes | Yes (v1 API) | Yes |

**关键发现：所有 5 个模型都使用相同的 OpenAI 兼容 tools/tool_calls 格式。** 可以在 `openai-compatible.ts` 中一次实现，所有模型自动获得工具调用能力。

**注意事项：**
- DeepSeek-R1（推理模型）不支持 function calling，只有 deepseek-chat (V3) 支持
- DeepSeek 建议工具调用时设 `temperature: 0`
- GLM 还支持内置的 `web_search` 和 `code_interpreter` 工具

**实现难度：** 中（在 openai-compatible.ts 加一个工具调用循环，约 50-100 行代码）

**优先级：P1** — 价值大，但需要先定义工具注册机制（依赖中间件系统）

---

### 4. Bedrock / Vertex AI 支持

**解决什么问题：** 用户通过 AWS/GCP 使用 Claude，不想直接用 Anthropic API key。

**真实需求：** 项目 owner 自己就用 AWS Bedrock，这是第一手需求。

**实现难度：** 小（claude-agent.ts 加后端切换，环境变量检测）

**优先级：P1** — 改动小、有明确用户（你自己）

---

### 5. 图片收发 + 多模态理解

**解决什么问题：** 微信用户发图片，bot 无法理解；bot 也无法回复图片。

**真实需求证据：**
- iLink 协议已支持 `image_item`（MessageItemType.IMAGE = 2）
- types.ts 已定义 `MediaAttachment` 类型，架构预留了
- chatgpt-on-wechat 的描述特别强调"能处理文本、语音、图片和文件"
- GPT-4o、Qwen-VL、Gemini 都是多模态模型，不用白不用

**场景：**
- 用户发截图问"这个报错什么意思"
- 用户发产品图片问"帮我写个文案"
- 用户发菜单图片问"有什么推荐"

**实现难度：** 中（接收图片 URL → 下载 → base64 编码 → 发给多模态模型）

**优先级：P1** — 微信高频操作，不支持图片是明显短板

---

### 6. 语音消息 (ASR)

**解决什么问题：** 微信用户发语音，bot 无法处理。

**真实需求证据：**
- 微信语音消息使用率极高，尤其是中老年用户
- chatgpt-on-wechat 在描述中强调"响应语音消息"
- iLink 协议支持 `voice_item`（MessageItemType.VOICE = 3）

**技术链路（已调研清楚）：**
```
微信语音 (silk v3 格式)
    ↓
silk-wasm 解码为 PCM        ← npm: silk-wasm (WASM, 跨平台)
    ↓
PCM → mp3/wav               ← ffmpeg 或 lamejs
    ↓
Whisper API / 讯飞 ASR       ← 语音转文字
    ↓
文字 → AI 模型处理            ← 现有流程
```

**ASR 选型：**
- Whisper API：效果好、中英混合准，$0.006/分钟
- 讯飞：中文最准，国内延迟低
- 本地 Whisper（whisper.cpp + whisper-node）：免费、隐私好

**微信特有坑：** silk 格式不是标准音频，需要 `silk-wasm` 解码。这是必须处理的一步。

**实现难度：** 中（主要工作在 silk 转码和 ASR 集成）

**优先级：P2** — 重要但链路较长，建议图片先做

---

### 7. Telegram 渠道

**解决什么问题：** 项目目前只支持微信，"通用中间层"名不副实。

**真实需求证据：**
- README 已承诺"Telegram / Discord 渠道"
- nexu (637 stars) 已在做"桥接 Agent 到 WeChat、Feishu、Slack、Discord"
- Telegram Bot API 比微信 iLink 简单得多，是最好的第二渠道

**实现难度：** 中（Telegram Bot API 很标准，但需要抽象好 Channel 接口）

**优先级：P2** — 对"通用中间层"定位重要，但不是核心用户当前最需要的

---

### 8. 跨渠道消息转发

**解决什么问题：** 不同平台的用户（微信 vs Telegram）无法互通。

**真实需求证据：**
- GitHub 搜索 "wechat telegram bridge" 结果为空 — **市场空白**
- nexu 在做类似的事但定位是桌面客户端，不是中间层
- matterbridge（跨平台消息桥接）概念已被验证

**场景：**
- 国内外团队：国内微信、海外 Telegram，消息自动同步
- 开源社区：GitHub 通知同时发到微信和 Discord

**实现难度：** 中（依赖 Telegram 渠道先做好）

**优先级：P3** — 有想象空间但依赖前置工作

---

### 9. MCP 支持

**解决什么问题：** 让用户可以挂载任意外部工具（数据库、文件系统、API 等）。

**调研结论：**
- MCP 是 Anthropic 2024 年 11 月推出的开放协议，标准化 AI 应用连接外部工具
- TypeScript SDK：`@modelcontextprotocol/sdk`
- Claude Desktop、VS Code、Cursor 已原生支持
- OpenAI 2025 年 3 月宣布 Agents SDK 支持 MCP
- 生态有数百个社区 MCP server（GitHub、Slack、数据库等）

**对 wechat-ai 的意义：** 作为 MCP **client**（不是 server），连接现有 MCP server 生态，让所有模型（不只 Claude）都能用外部工具。

**实现难度：** 大（需要理解 MCP 协议、实现 client、工具注册与调用）

**优先级：P3** — 价值大但工程量大，且依赖中间件系统和 function calling 先做好

---

### 10. Claude Agent SDK vs 自实现工具循环

**调研结论：**
Agent SDK 本质上是一个工具调用循环的封装。自己实现只需约 100 行代码：

```
1. 发送消息 + tools 定义
2. 检查响应是否有 tool_use
3. 有 → 执行工具，收集结果，发回，回到 2
4. 无 → 返回最终文本
```

**好处：**
- 从 65MB 降到 ~5MB（去掉 claude-agent-sdk）
- 统一架构：所有模型共享同一个工具调用循环
- 可控性更强：自定义安全检查、超时、日志

**风险：** Agent SDK 内置工具（Bash、Read、WebSearch 等）需要自己实现

**建议：** 中期考虑，不急。先用 Agent SDK 把功能跑通，等架构稳了再替换。

---

## 不建议做的

| 功能 | 原因 |
|------|------|
| 撤回消息处理 | 极低频，用户直接发新消息纠错更自然 |
| 模板市场 | 面向终端用户的产品功能，与中间层定位冲突 |
| 付费/托管服务 | 与开源定位冲突 |
| 群聊支持 | iLink 当前不支持，等腾讯开放 |

---

## 实施路线图

```
Phase 1 (基础设施)
├── Webhook HTTP 入口          ← 最快见效
├── 中间件系统 bot.use()       ← 架构核心
└── Bedrock/Vertex 支持        ← 小改动

Phase 2 (消息能力)
├── 图片收发 + 多模态          ← 补齐短板
├── 所有模型 Function Calling  ← 统一工具调用
└── 语音消息 ASR               ← 高频需求

Phase 3 (生态扩展)
├── Telegram 渠道              ← 多渠道第一步
├── 跨渠道消息转发              ← 差异化
└── MCP 支持                   ← 工具生态
```
