# wechat-ai

微信 AI 机器人 — 一条命令连接微信与任意 AI 模型。

<p align="center">
  <img src="docs/screenshot.png" width="800" alt="wechat-ai screenshot" />
</p>

```bash
npm i -g wechat-ai
wechat-ai set qwen sk-xxx
wechat-ai
```

## 支持模型

| 模型 | 默认版本 | 设置 Key |
|------|---------|---------|
| 通义千问 (Qwen) | qwen-plus | `wechat-ai set qwen <key>` |
| DeepSeek | deepseek-chat | `wechat-ai set deepseek <key>` |
| Claude | claude-opus-4-6 (Agent) | `wechat-ai set claude <key>` |
| GPT | gpt-4o | `wechat-ai set gpt <key>` |
| Gemini | gemini-2.0-flash | `wechat-ai set gemini <key>` |
| MiniMax | MiniMax-Text-01 | `wechat-ai set minimax <key>` |
| 智谱 (GLM) | glm-4-plus | `wechat-ai set glm <key>` |

支持任何 OpenAI 兼容 API，编辑 `~/.wai/config.json` 即可添加。

Claude 通过 [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 接入，支持执行代码、读写文件、搜索网页，不只是聊天。

## 安装运行

```bash
# 方式一：直接运行（无需安装）
npx wechat-ai

# 方式二：全局安装
npm i -g wechat-ai

# 方式三：克隆源码
git clone https://github.com/anxiong2025/wechat-ai.git
cd wechat-ai && npm install && npm run build && node dist/cli.js
```

## 命令

```bash
wechat-ai                        # 启动（首次自动弹出二维码）
wechat-ai set <模型> <key>        # 保存 API Key
wechat-ai use <模型>              # 设置默认模型
wechat-ai config                 # 查看配置（Key 已脱敏）
wechat-ai update                 # 更新到最新版
```

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

## 微信协议

直接实现微信 ilink bot API，不依赖 OpenClaw：

- 登录：`ilink/bot/get_bot_qrcode` 扫码
- 收消息：`ilink/bot/getupdates` 长轮询
- 发消息：`ilink/bot/sendmessage`
- 输入状态：`ilink/bot/sendtyping`

参考：[@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) (MIT)

## 计划

- [x] 微信 ilink 协议
- [x] 多模型切换 (`/model`)
- [x] 输入状态提示
- [x] 7 个内置模型
- [x] npm 发布
- [ ] 图片/文件收发
- [ ] Telegram / Discord 渠道
- [ ] MCP 支持

## 协议

MIT
