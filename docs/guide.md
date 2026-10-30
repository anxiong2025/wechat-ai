# wechat-ai 使用指南

## 快速开始

### 1. 安装

```bash
npm i -g wechat-ai
```

### 2. 设置 API Key（任选一个）

```bash
wechat-ai set qwen sk-xxx        # 通义千问（推荐，国内最稳）
wechat-ai set deepseek sk-xxx    # DeepSeek（擅长推理和代码）
wechat-ai set gemini AIza-xxx    # Gemini
wechat-ai set gpt sk-xxx         # GPT-4o
```

### 3. 启动

```bash
wechat-ai                        # 首次扫码登录，之后自动连接
```

扫码后，给机器人发消息即可对话。

---

## 微信指令

### 基本操作

| 指令 | 说明 |
|------|------|
| 直接发消息 | AI 对话 |
| `/model` | 查看当前模型 |
| `/model qwen` | 切换到千问 |
| `/model deepseek` | 切换到 DeepSeek |
| `/cc` | 切换到 Claude |
| `/help` | 显示帮助 |
| `/ping` | 检查状态 |

### 快捷切换模型

```
/cc       → Claude（最强，需 Claude Key）
/qwen     → 通义千问
/deepseek → DeepSeek
/gpt      → GPT-4o
/gemini   → Gemini
```

### 第三方模型（OpenRouter）

配置 OpenRouter Key 后可使用 600+ 模型：

```bash
wechat-ai set openrouter sk-or-xxx
```

微信里切换：

```
/model google/gemini-2.5-pro         # Google Gemini Pro
/model anthropic/claude-sonnet-4     # Claude Sonnet
/model xiaomi/mimo-v2-pro            # 小米 MiMo
/model openai/gpt-5.4                # GPT-5.4
```

### 免费模型（无需充值）

```
/model stepfun/step-3.5-flash:free
/model nvidia/nemotron-3-super-120b-a12b:free
```

更多免费模型：[OpenRouter Models](https://openrouter.ai/models)（筛选 Prompt pricing: $0）

---

## Agent 能力

v0.4.0 起，**所有模型**均具备 Agent 能力，不只是聊天。

### 能做什么

| 能力 | 示例消息 | 说明 |
|------|---------|------|
| 搜索网页 | "今天深圳天气怎么样" | 自动搜索实时信息并总结 |
| 查资讯 | "最新的 AI 行业动态" | 搜索国内外新闻 |
| 硅谷动态 | "OpenAI 最近发了什么新产品" | 搜索科技公司最新消息 |
| 读取文件 | "读取 /home/user/config.json" | 读取服务器上的文件内容 |
| 写入文件 | "创建一个 hello.txt 写入 Hello World" | 创建或修改文件 |
| 搜索文件 | "找到所有 .log 文件" | 按模式匹配文件路径 |
| 搜索内容 | "在代码里搜索 TODO" | 按正则搜索文件内容 |
| 执行命令 | "运行 ls -la" | 执行 shell 命令并返回结果 |
| 抓取网页 | "抓取这个网址的内容：https://..." | 获取指定 URL 的文本内容 |

### 工作原理

```
你发消息："今天天气怎么样"
    ↓
AI 决定需要搜索 → 调用 web_search("深圳天气")
    ↓
搜索返回结果 → AI 可能再调用 web_fetch 抓取详情
    ↓
AI 汇总信息 → 返回给你完整的天气报告
```

这个过程是自动的，你不需要做任何额外操作。

### 支持的内置工具

| 工具 | 功能 |
|------|------|
| `web_search` | 搜索网页（DuckDuckGo，无需额外 Key） |
| `web_fetch` | 抓取指定 URL 内容 |
| `read` | 读取文件（支持行号范围） |
| `write` | 写入/创建文件 |
| `glob` | 按模式搜索文件路径 |
| `grep` | 按正则搜索文件内容 |
| `bash` | 执行 shell 命令（有安全限制） |

由 [claw-agent-sdk](https://github.com/anxiong2025/claw-agent-sdk) 提供，无需额外配置。

---

## Skills 人设

切换不同 AI 角色：

```
/skill translator  → 中英翻译助手
/skill coder       → 编程助手
/skill writer      → 写作助手
/skill off         → 关闭人设，恢复默认
```

### 自定义 Skill

编辑 `~/.wai/config.json`：

```json
{
  "skills": {
    "lawyer": {
      "description": "法律顾问",
      "systemPrompt": "你是一个专业律师，用通俗易懂的语言解答法律问题。"
    },
    "fitness": {
      "description": "健身教练",
      "systemPrompt": "你是一个专业健身教练，根据用户情况给出训练和饮食建议。"
    }
  }
}
```

---

## 语音消息

### 语音转文字（ASR）

发语音消息给机器人，自动转文字后交给 AI 处理。

```json
{
  "asr": {
    "provider": "whisper",
    "apiKey": "sk-xxx"
  }
}
```

### 文字转语音（TTS）

AI 回复自动合成语音发送。

```json
{
  "tts": {
    "provider": "openai",
    "apiKey": "sk-xxx",
    "voice": "alloy"
  }
}
```

---

## 图片功能

### AI 生成图片

```
/画 一只在月球上喝咖啡的猫
```

### 图片理解

直接发图片给机器人，自动切换到视觉模型分析图片内容。

---

## 支持的模型

| 模型 | 命令 | 价格 | 适合场景 |
|------|------|------|---------|
| 通义千问 | `/qwen` | 极低 | 日常对话，中文最佳 |
| DeepSeek | `/deepseek` | 极低 | 推理、代码 |
| Claude | `/cc` | 中等 | 最强质量，复杂任务 |
| GPT-4o | `/gpt` | 中等 | 综合能力强 |
| Gemini | `/gemini` | 低 | 多模态、长上下文 |
| MiniMax | `/model minimax` | 低 | 中文对话 |
| GLM | `/model glm` | 低 | 中文对话 |
| OpenRouter | `/model vendor/model` | 按模型定价 | 600+ 模型任选 |

### 获取 API Key

| 模型 | 申请地址 |
|------|---------|
| 通义千问 | [阿里云百炼](https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key) |
| DeepSeek | [DeepSeek 平台](https://platform.deepseek.com/api_keys) |
| Claude | [Anthropic Console](https://console.anthropic.com/settings/keys) |
| GPT | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Gemini | [Google AI Studio](https://aistudio.google.com/apikey) |
| OpenRouter | [OpenRouter](https://openrouter.ai/settings/keys) |

---

## 高级配置

配置文件位于 `~/.wai/config.json`。

### MCP 工具扩展

通过 [MCP](https://modelcontextprotocol.io) 协议接入外部工具：

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@weather/mcp-server"]
    }
  }
}
```

### Webhook（HTTP API）

启用后可通过 HTTP 主动发消息：

```json
{
  "webhook": {
    "enabled": true,
    "port": 4800,
    "secret": "your-secret"
  }
}
```

```bash
curl -X POST http://localhost:4800 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret" \
  -d '{"targetId": "wxid_xxx", "text": "Hello"}'
```

### 后台运行

```bash
wechat-ai start    # 后台启动
wechat-ai stop     # 停止
wechat-ai logs     # 查看日志
```

---

## 常见问题

**Q: 为什么 AI 回复是英文？**
A: 检查 `~/.wai/config.json` 里的 `systemPrompt`，确保包含 "Always reply in the same language the user uses"。

**Q: 搜索功能需要额外配置吗？**
A: 不需要。搜索使用 DuckDuckGo，完全免费，无需任何 API Key。

**Q: 可以同时用多个模型吗？**
A: 可以。用 `/model` 切换，每个用户独立记录当前模型。

**Q: OpenRouter 免费模型能用吗？**
A: 能用，但免费模型可能有限流。建议用千问或 DeepSeek，价格极低且稳定。

**Q: Claude 和其他模型有什么区别？**
A: `/cc` 走 Claude 官方 Agent SDK，质量最强。其他模型走 claw-agent-sdk，能力相同但效果取决于模型本身的智能程度。

**Q: 每次上线都会发一条问候消息，能关掉或修改吗？**
A: 可以。`wechat-ai greeting off` 关闭；`wechat-ai greeting 你好，我上线了` 自定义；`wechat-ai greeting on` 恢复默认。也可以直接编辑 `~/.wai/config.json` 里的 `channels.weixin.greeting`（`false` 为关闭）。

**Q: Windows 下二维码扫不出来？**
A: 新版在 Windows 上默认使用大尺寸二维码，并会在二维码下方打印原始链接，可粘贴到任意二维码生成工具后扫码。如果仍然显示错乱，可在 PowerShell 窗口「属性 → 字体」里换成等宽字体，或改用 Windows Terminal。也可以用环境变量 `WAI_QR_SMALL=1` / `WAI_QR_SMALL=0` 手动切换小 / 大二维码。

**Q: 怎么用 Claude Pro / Max 订阅？**
A: `/cc` 通过 Claude Agent SDK 调用 Claude。推荐用 API Key：`wechat-ai set claude sk-ant-xxx`（在 [Anthropic Console](https://console.anthropic.com/settings/keys) 申请）。未配置 Key 时，SDK 会尝试使用本机 Claude Code 的登录凭证（`~/.claude`），但 Anthropic 的条款要求基于 Agent SDK 的应用使用 API Key 认证，订阅额度能否用于此类场景请以 Anthropic 官方说明为准。

**Q: 能发送语音回复吗？**
A: 目前微信 iLink 接口不支持上传媒体（`uploadmedia` 返回 404），语音回复会自动降级为文字发送，且本次运行中不再重复尝试。
