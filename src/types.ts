// ── Core message types flowing through the system ──

export interface InboundMessage {
  /** Unique message ID from the channel */
  id: string;
  /** Channel identifier (e.g. "weixin", "telegram") */
  channel: string;
  /** Sender identifier within the channel */
  senderId: string;
  /** Display name of sender (if available) */
  senderName?: string;
  /** Text content */
  text: string;
  /** Optional media attachments */
  media?: MediaAttachment[];
  /** Opaque channel-specific metadata needed for replies */
  replyToken?: string;
  /** Whether the original input was voice (for TTS reply) */
  isVoice?: boolean;
  /** Timestamp (ms) */
  timestamp: number;
}

export interface OutboundMessage {
  /** Target sender ID */
  targetId: string;
  /** Text content */
  text: string;
  /** Optional media */
  media?: MediaAttachment[];
  /** Voice audio buffer (mp3) — if set, channel should send as voice message */
  voice?: Buffer;
  /** Opaque reply token from inbound */
  replyToken?: string;
}

export interface MediaAttachment {
  type: "image" | "voice" | "video" | "file";
  url?: string;
  path?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
}

// ── Channel abstraction ──

export interface Channel {
  readonly name: string;

  /** Initialize and authenticate */
  login(): Promise<void>;

  /** Check if a saved session exists (for reuse prompt) */
  hasSession?(): boolean;

  /** Display label for the saved session (e.g. account ID) */
  sessionLabel?(): string;

  /** Clear saved session data so next start triggers re-login */
  clearSession?(): Promise<void>;

  /** Start receiving messages. Calls onMessage for each inbound. */
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;

  /** Send a reply */
  send(msg: OutboundMessage): Promise<void>;

  /** Whether voice replies can be sent (false skips TTS) */
  canSendVoice?(): boolean;

  /** Graceful shutdown */
  stop(): Promise<void>;
}

// ── AI Provider abstraction ──

export interface ProviderResponse {
  text: string;
  /** Whether the provider is still generating (for streaming) */
  done: boolean;
  /** Token usage if available */
  usage?: { input: number; output: number };
}

export interface ProviderOptions {
  /** Model override */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Max tokens */
  maxTokens?: number;
  /** Allowed tools (provider-specific) */
  allowedTools?: string[];
  /** Working directory for agent-type providers */
  cwd?: string;
  /** Media attachments (images, voice, etc.) */
  media?: MediaAttachment[];
  /** MCP tools in OpenAI function calling format */
  mcpTools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  /** Callback to execute an MCP tool */
  mcpCallTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface Provider {
  readonly name: string;

  /** Send a prompt and get a complete response */
  query(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): Promise<string>;

  /** Send a prompt and stream responses */
  stream?(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): AsyncIterable<ProviderResponse>;
}

// ── Middleware ──

export interface Context {
  /** The inbound message */
  message: InboundMessage;
  /** Set this to override the AI response (skips provider call) */
  response?: string;
  /** The resolved provider name */
  provider: string;
  /** The channel instance */
  channel: Channel;
  /** Session key (channel:senderId) */
  sessionKey: string;
  /** Arbitrary data shared between middlewares */
  state: Record<string, unknown>;
}

export type NextFunction = () => Promise<void>;
export type Middleware = (ctx: Context, next: NextFunction) => Promise<void>;

// ── Configuration ──

export interface McpServerConfig {
  /** Transport type: "stdio" (default), "sse", or "streamable-http" */
  transport?: "stdio" | "sse" | "streamable-http";
  /** Command to run (stdio) */
  command?: string;
  /** Command arguments (stdio) */
  args?: string[];
  /** Environment variables (stdio) */
  env?: Record<string, string>;
  /** Server URL (sse / streamable-http) */
  url?: string;
}

export interface WebhookConfig {
  /** Enable webhook HTTP server */
  enabled?: boolean;
  /** Port to listen on (default: 4800) */
  port?: number;
  /** Optional secret token for authentication */
  secret?: string;
}

export interface SkillConfig {
  /** Human-readable description */
  description?: string;
  /** System prompt override */
  systemPrompt: string;
  /** Provider override (optional, falls back to user's current provider) */
  provider?: string;
}

export interface WaiConfig {
  /** Default AI provider to use */
  defaultProvider: string;

  /** Provider configurations */
  providers: Record<string, ProviderConfig>;

  /** Channel configurations */
  channels: Record<string, ChannelConfig>;

  /** Per-user provider overrides: senderId -> providerName */
  userRoutes?: Record<string, string>;

  /** Per-user model overrides (for OpenRouter etc.): senderId -> model name */
  userModelOverrides?: Record<string, string>;

  /** Per-user active skill: senderId -> skillName */
  userSkills?: Record<string, string>;

  /** Skill presets */
  skills?: Record<string, SkillConfig>;

  /** Global system prompt */
  systemPrompt?: string;

  /** Message chunk size limit */
  chunkSize?: number;

  /** Webhook HTTP server config */
  webhook?: WebhookConfig;

  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;

  /** ASR (speech-to-text) config for voice messages */
  asr?: {
    provider?: "whisper" | "disabled";
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };

  /** TTS (text-to-speech) config for voice replies */
  tts?: {
    provider?: "openai" | "gemini" | "disabled";
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    voice?: string;
    maxChars?: number;
  };
}

export interface ProviderConfig {
  type: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  allowedTools?: string[];
  [key: string]: unknown;
}

export interface ChannelConfig {
  type: string;
  enabled?: boolean;
  [key: string]: unknown;
}
