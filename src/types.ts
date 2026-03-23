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

  /** Start receiving messages. Calls onMessage for each inbound. */
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;

  /** Send a reply */
  send(msg: OutboundMessage): Promise<void>;

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

export interface WebhookConfig {
  /** Enable webhook HTTP server */
  enabled?: boolean;
  /** Port to listen on (default: 4800) */
  port?: number;
  /** Optional secret token for authentication */
  secret?: string;
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

  /** Global system prompt */
  systemPrompt?: string;

  /** Message chunk size limit */
  chunkSize?: number;

  /** Webhook HTTP server config */
  webhook?: WebhookConfig;
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
