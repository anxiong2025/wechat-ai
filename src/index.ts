// Public API for programmatic usage
export { Gateway } from "./gateway.js";
export { loadConfig, saveConfig } from "./config.js";
export { WeixinChannel } from "./channels/weixin.js";
export { ClaudeAgentProvider } from "./providers/claude-agent.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export type {
  Channel,
  Provider,
  InboundMessage,
  OutboundMessage,
  WaiConfig,
  ProviderConfig,
  ChannelConfig,
  ProviderOptions,
  ProviderResponse,
  MediaAttachment,
  Context,
  Middleware,
  NextFunction,
} from "./types.js";
