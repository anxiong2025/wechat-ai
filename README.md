# wechat-ai

微信 AI 机器人 — 一条命令连接微信与任意 AI 模型。

<p align="center">
  <img src="docs/screenshot.png" width="800" alt="wechat-ai screenshot" />
</p>

## 快速开始

### 1. 安装

```bash
npm i -g wechat-ai
```

### 2. 设置 API Key（任选一个模型）

```bash
# macOS / Linux
wechat-ai set qwen sk-xxx        # 通义千问
wechat-ai set deepseek sk-xxx    # DeepSeek
wechat-ai set gemini AIza-xxx    # Gemini

# Windows（Key 需要加引号，避免特殊字符被 cmd 解析）
wechat-ai set qwen "sk-xxx"
wechat-ai set deepseek "sk-xxx"
```

### 3. 启动

```bash
wechat-ai                        # 首次启动会弹出微信扫码
```

扫码登录后，给微信机器人发消息即可开始对话。

## 其他安装方式

```bash
# 免安装体验
npx wechat-ai

# 从源码运行
git clone https://github.com/anthropics/wechat-ai.git
cd wechat-ai && npm install && npm run build && node dist/cli.js
```

## 命令

```bash
wechat-ai                        # 启动（首次自动弹出二维码）
wechat-ai set <模型> <key>        # 保存 API Key
wechat-ai use <模型>              # 设置默认模型
wechat-ai config                 # 查看配置（Key 已脱敏）
wechat-ai start                  # 后台运行（daemon 模式）
wechat-ai stop                   # 停止后台进程
wechat-ai logs                   # 查看后台日志
wechat-ai update                 # 更新到最新版
```

## 支持模型

| 模型 | 默认版本 | 设置 Key | 获取 Key |
|------|---------|---------|---------|
| 通义千问 (Qwen) | qwen-plus | `wechat-ai set qwen <key>` | [申请](https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key) |
| DeepSeek | deepseek-chat | `wechat-ai set deepseek <key>` | [申请](https://platform.deepseek.com/api_keys) |
| Claude | claude-opus-4-6 (Agent) | `wechat-ai set claude <key>` | [申请](https://console.anthropic.com/settings/keys) |
| GPT | gpt-4o | `wechat-ai set gpt <key>` | [申请](https://platform.openai.com/api-keys) |
| Gemini | gemini-2.0-flash | `wechat-ai set gemini <key>` | [申请](https://aistudio.google.com/apikey) |
| MiniMax | MiniMax-Text-01 | `wechat-ai set minimax <key>` | [申请](https://platform.minimaxi.com/user-center/basic-information/interface-key) |
| 智谱 (GLM) | glm-4-plus | `wechat-ai set glm <key>` | [申请](https://open.bigmodel.cn/usercenter/apikeys) |

支持任何 OpenAI 兼容 API，编辑 `~/.wai/config.json` 即可添加。

Claude 通过 [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 接入，支持执行代码、读写文件、搜索网页，不只是聊天。

### 微信内指令

```
/model              查看当前模型
/model deepseek     切换到 DeepSeek
/model qwen         切换到 Qwen
/help               显示指令列表
/ping               检查状态
```

## 架构

```
微信 ──ilink──> wechat-ai 网关 ──路由──> AI 模型
                    │                   │
               会话管理            ┌────┴────┐
               模型路由            │         │
                             Claude Agent  OpenAI 兼容
                             (工具: Bash,  (Qwen, DeepSeek,
                              Read, Web)   GPT, Gemini...)
```

## 项目结构

```
src/
├── cli.ts                    命令行入口
├── gateway.ts                消息路由 & 会话管理
├── config.ts                 配置 (~/.wai/config.json)
├── types.ts                  核心接口定义
├── channels/weixin.ts        微信 ilink 协议实现
└── providers/
    ├── claude-agent.ts       Claude Agent SDK
    └── openai-compatible.ts  通用 OpenAI 兼容
```

## 计划

- [x] 微信 ilink 协议
- [x] 多模型切换 (`/model`)
- [x] 输入状态提示
- [x] 7 个内置模型
- [x] npm 发布
- [x] 中间件系统
- [x] MCP 客户端支持
- [x] 所有模型 Function Calling
- [x] 后台运行 (daemon 模式)
- [ ] 图片/文件收发
- [ ] 语音消息 (ASR/TTS)
- [ ] Telegram / Discord 渠道

## 协议

MIT
