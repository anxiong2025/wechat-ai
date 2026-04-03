// Public API for programmatic usage
export { Gateway } from "./gateway.js";
export { loadConfig, saveConfig } from "./config.js";
export { WeixinChannel } from "./channels/weixin.js";
export { DiscordChannel } from "./channels/discord.js";
export { WhatsAppChannel } from "./channels/whatsapp.js";
export { ClaudeAgentProvider } from "./providers/claude-agent.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export { McpManager } from "./mcp.js";
export type {
  Channel,
  Provider,
  InboundMessage,
  OutboundMessage,
  WaiConfig,
  ProviderConfig,
  ChannelConfig,
  SkillConfig,
  McpServerConfig,
  ProviderOptions,
  ProviderResponse,
  MediaAttachment,
  Context,
  Middleware,
  NextFunction,
} from "./types.js";
