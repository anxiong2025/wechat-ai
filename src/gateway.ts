import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "./logger.js";
import type {
  Channel,
  Provider,
  InboundMessage,
  WaiConfig,
  ProviderOptions,
  Middleware,
  Context,
} from "./types.js";
import { WeixinChannel } from "./channels/weixin.js";
import { DiscordChannel } from "./channels/discord.js";
import { WhatsAppChannel } from "./channels/whatsapp.js";
import { ClaudeAgentProvider } from "./providers/claude-agent.js";
import { ClawAgentProvider } from "./providers/claw-agent.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { McpManager } from "./mcp.js";
import { transcribeFromUrl } from "./asr.js";
import { textToSpeech } from "./tts.js";

const log = createLogger("网关");

const DEBOUNCE_MS = 1500;
const DEBOUNCE_MEDIA_MS = 4000;

interface MessageBuffer {
  messages: InboundMessage[];
  timer: ReturnType<typeof setTimeout>;
}

export class Gateway {
  private channels = new Map<string, Channel>();
  private providers = new Map<string, Provider>();
  private config: WaiConfig;
  // Debounce buffer: accumulates messages within DEBOUNCE_MS window
  private buffers = new Map<string, MessageBuffer>();
  // Whether AI is currently processing for a given user
  private processing = new Set<string>();
  // Queue for messages that arrive while AI is processing
  private queues = new Map<string, InboundMessage[]>();
  // Per-message provider override (from @model syntax)
  private atProviders = new Map<string, string>();
  // Middleware stack
  private middlewares: Middleware[] = [];
  // Provider descriptions for switch messages
  private static PROVIDER_TIPS: Record<string, string> = {
    claude: "Claude Agent · 支持搜索/代码/文件",
    qwen: "通义千问",
    deepseek: "DeepSeek · 擅长推理和代码",
    gpt: "GPT-4o",
    gemini: "Gemini",
    minimax: "MiniMax",
    glm: "智谱 GLM",
    openrouter: "OpenRouter · 300+ 第三方模型",
  };
  // Webhook HTTP server
  private webhookServer: Server | null = null;
  // MCP client manager
  private mcp = new McpManager();

  constructor(config: WaiConfig) {
    this.config = config;
  }

  /** Register a middleware function */
  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  init(): void {
    for (const [name, chConfig] of Object.entries(this.config.channels)) {
      if (chConfig.enabled === false) continue;
      switch (chConfig.type) {
        case "weixin":
          this.channels.set(name, new WeixinChannel(chConfig));
          break;
        case "discord":
          this.channels.set(name, new DiscordChannel(chConfig));
          break;
        case "whatsapp":
          this.channels.set(name, new WhatsAppChannel(chConfig));
          break;
        default:
          log.warn(`未知渠道类型: ${chConfig.type}`);
      }
    }

    for (const [name, provConfig] of Object.entries(this.config.providers)) {
      switch (provConfig.type) {
        case "claude-agent":
          this.providers.set(name, new ClaudeAgentProvider(provConfig));
          break;
        case "claw-agent":
          this.providers.set(name, new ClawAgentProvider(name, provConfig));
          break;
        case "openai-compatible":
          this.providers.set(name, new OpenAICompatibleProvider(name, provConfig));
          break;
        default:
          log.warn(`未知模型类型: ${provConfig.type}`);
      }
    }

    log.debug(`已初始化 ${this.channels.size} 个渠道, ${this.providers.size} 个模型`);
  }

  async login(channelName: string): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`渠道 "${channelName}" 不存在`);
    }
    await channel.login();
  }

  async start(): Promise<void> {
    if (this.providers.size === 0) {
      throw new Error("未配置任何模型");
    }

    // Connect MCP servers
    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      await this.mcp.connect(this.config.mcpServers);
      const toolCount = this.mcp.getTools().length;
      if (toolCount > 0) {
        log.info(`MCP: ${toolCount} 个工具已就绪`);
      }
    }

    this.startWebhook();

    const startPromises = [...this.channels.entries()].map(([name, channel]) => {
      log.debug(`启动渠道: ${name}`);
      return channel.start((msg) => this.handleMessage(msg)).catch((err) => {
        log.error(`渠道 ${name} 异常: ${err instanceof Error ? err.message : err}`);
      });
    });

    await Promise.all(startPromises);
  }

  async stop(): Promise<void> {
    log.info("正在关闭...");
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
    await this.mcp.disconnect();
    const stops = [...this.channels.values()].map((ch) => ch.stop());
    await Promise.allSettled(stops);
    log.info("已关闭");
  }

  private handleMessage(msg: InboundMessage): void {
    // Normalize full-width slash/at to half-width (Chinese IME)
    if (msg.text.startsWith("／")) {
      msg = { ...msg, text: "/" + msg.text.slice(1) };
    }

    // Support @command syntax: @画图 xxx, @模型名 xxx
    const atMatch = msg.text.match(/^@(\S+)\s*(.*)/s);
    if (atMatch) {
      const atCmd = atMatch[1]!;
      const atArg = atMatch[2] || "";
      // @画图 → /画
      if (atCmd === "画图" || atCmd === "draw") {
        msg = { ...msg, text: `/画 ${atArg}`.trim() };
      }
      // @指南 → send guide directly (no AI)
      else if (atCmd === "指南" || atCmd === "guide") {
        msg = { ...msg, text: "/guide" };
      }
      // @模型名 → route to that provider for this message
      else if (this.providers.has(atCmd.toLowerCase())) {
        const key = `${msg.channel}:${msg.senderId}`;
        this.atProviders.set(key, atCmd.toLowerCase());
        msg = { ...msg, text: atArg || msg.text };
      }
    }

    // Commands bypass debounce, execute immediately
    if (msg.text.startsWith("/")) {
      this.handleCommand(msg);
      return;
    }

    const key = `${msg.channel}:${msg.senderId}`;

    // If AI is processing, queue the message
    if (this.processing.has(key)) {
      const queue = this.queues.get(key) || [];
      queue.push(msg);
      this.queues.set(key, queue);
      log.info(`消息已排队 (AI处理中), 队列长度: ${queue.length}`);
      return;
    }

    // Debounce: accumulate messages within time window
    // Use longer window for media messages (user likely typing a follow-up)
    const existing = this.buffers.get(key);
    const hasMedia = msg.media?.length || existing?.messages.some((m) => m.media?.length);
    const delay = hasMedia ? DEBOUNCE_MEDIA_MS : DEBOUNCE_MS;
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = setTimeout(() => this.flushBuffer(key), delay);
    } else {
      this.buffers.set(key, {
        messages: [msg],
        timer: setTimeout(() => this.flushBuffer(key), delay),
      });
    }
  }

  private async flushBuffer(key: string): Promise<void> {
    const buf = this.buffers.get(key);
    if (!buf || buf.messages.length === 0) return;
    this.buffers.delete(key);

    // Merge all buffered messages into one
    const merged = this.mergeMessages(buf.messages);
    await this.processMessage(merged);

    // After processing, check if there are queued messages
    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      this.queues.delete(key);
      // Feed queued messages back through debounce
      for (const msg of queue) {
        this.handleMessage(msg);
      }
    }
  }

  private mergeMessages(messages: InboundMessage[]): InboundMessage {
    if (messages.length === 1) return messages[0]!;

    const last = messages[messages.length - 1]!;
    const mergedText = messages.map((m) => m.text).join("\n");

    // Merge media from all messages
    const allMedia = messages.flatMap((m) => m.media || []);

    log.info(`合并 ${messages.length} 条消息`);

    const isVoice = messages.some((m) => m.isVoice);

    return {
      ...last,
      text: mergedText,
      media: allMedia.length > 0 ? allMedia : undefined,
      isVoice: isVoice || undefined,
    };
  }

  private async processMessage(msg: InboundMessage): Promise<void> {
    const key = `${msg.channel}:${msg.senderId}`;
    this.processing.add(key);

    try {
      const channel = this.channels.get(msg.channel);
      if (!channel) return;

      // Voice → text: transcribe voice messages before AI processing
      const voiceMedia = msg.media?.filter((m) => m.type === "voice" && m.url);
      const isVoiceInput = !!(msg.isVoice || voiceMedia?.length);
      if (voiceMedia?.length && this.config.asr?.provider !== "disabled") {
        for (const voice of voiceMedia) {
          const text = await transcribeFromUrl(voice.url!, this.config.asr || {});
          if (text) {
            msg = { ...msg, text: msg.text === "[媒体消息]" ? text : `${msg.text}\n${text}` };
          }
        }
      }

      // Resolve skill overrides
      const activeSkillName = this.config.userSkills?.[msg.senderId];
      const activeSkill = activeSkillName ? this.config.skills?.[activeSkillName] : undefined;

      // Check for @model override (consumed once)
      const atProvider = this.atProviders.get(key);
      if (atProvider) this.atProviders.delete(key);

      let providerName = atProvider
        || activeSkill?.provider
        || this.config.userRoutes?.[msg.senderId]
        || this.config.defaultProvider;

      // Auto-route: if message has images and current provider doesn't support vision,
      // fall back to a vision-capable provider
      const hasImages = msg.media?.some((m) => m.type === "image");
      if (hasImages && !this.isVisionCapable(providerName)) {
        const fallback = this.findVisionProvider();
        if (fallback) {
          log.info(`图片消息: ${providerName} 不支持多模态, 自动切换到 ${fallback}`);
          providerName = fallback;
        }
      }

      const ctx: Context = {
        message: msg,
        provider: providerName,
        channel,
        sessionKey: key,
        state: {},
      };

      // Build the middleware chain with AI call as the innermost handler
      const coreHandler: Middleware = async (c) => {
        const provider = this.providers.get(c.provider);
        if (!provider) {
          log.error(`模型 "${c.provider}" 未找到`);
          return;
        }

        // Check if the provider has usable auth
        const provConfig = this.config.providers[c.provider];
        const envKey = (provConfig as Record<string, unknown>)?.apiKeyEnv as string | undefined;
        const hasAuth = provConfig?.apiKey
          || (envKey && process.env[envKey])
          || provConfig?.type === "claude-agent"; // claude-agent has its own auth (SDK / ~/.claude)
        if (!hasAuth) {
          c.response = `当前模型 ${c.provider} 未配置 API Key，请在终端执行:\nwechat-ai set ${c.provider} <your-key>`;
          return;
        }

        log.info(`${c.provider} 处理中...`);

        if ("sendTyping" in c.channel) {
          (c.channel as any).sendTyping(c.message.senderId, c.message.replyToken);
        }

        const options: ProviderOptions = {};

        // Pass per-user model override (e.g. OpenRouter vendor/model)
        const modelOverride = this.config.userModelOverrides?.[msg.senderId];
        if (modelOverride) {
          options.model = modelOverride;
        }

        // Skill system prompt takes priority over global
        let systemPrompt = activeSkill?.systemPrompt || this.config.systemPrompt;
        // Voice mode: ask AI to be concise for TTS
        if (isVoiceInput && this.config.tts?.provider !== "disabled") {
          systemPrompt = (systemPrompt || "") + "\n\n[语音模式] 用户通过语音提问，请用简短口语化的方式回答，控制在200字以内。不要使用 markdown 格式、列表或代码块。";
        }
        options.systemPrompt = systemPrompt;

        // Pass media attachments if present
        if (c.message.media?.length) {
          options.media = c.message.media;
        }

        // Pass MCP tools if available
        const mcpTools = this.mcp.getOpenAITools();
        if (mcpTools.length > 0) {
          options.mcpTools = mcpTools;
          options.mcpCallTool = (name, args) => this.mcp.callTool(name, args);
        }

        c.response = await provider.query(c.message.text, c.sessionKey, options);
      };

      // Compose: middlewares + core handler (Koa-style onion model)
      await this.compose(ctx, [...this.middlewares, coreHandler]);

      // Send response if available
      if (ctx.response) {
        let voiceBuffer: Buffer | null = null;

        // Voice input → try TTS for voice reply
        if (isVoiceInput && this.config.tts?.provider !== "disabled") {
          voiceBuffer = await textToSpeech(ctx.response, this.config.tts || {});
        }

        await channel.send({
          targetId: msg.senderId,
          text: ctx.response,
          voice: voiceBuffer ?? undefined,
          replyToken: msg.replyToken,
        });
        log.info(`已回复 (${ctx.response.length} 字符${voiceBuffer ? ", 语音" : ""})`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`处理消息失败: ${errMsg}`);

      try {
        const channel = this.channels.get(msg.channel);
        if (channel) {
          await channel.send({
            targetId: msg.senderId,
            text: `[出错了] 处理消息失败，请重试。`,
            replyToken: msg.replyToken,
          });
        }
      } catch {
        // swallow
      }
    } finally {
      this.processing.delete(key);
    }
  }

  // OpenAI-compatible providers that support vision (image_url in messages)
  // DeepSeek: deepseek-chat does NOT support vision
  private static readonly VISION_PROVIDERS = new Set([
    "qwen", "gpt", "gemini", "glm", "minimax",
  ]);

  private isVisionCapable(providerName: string): boolean {
    // All OpenAI-compatible providers support vision via image_url
    // Claude agent currently doesn't pass images
    return Gateway.VISION_PROVIDERS.has(providerName);
  }

  private findVisionProvider(): string | null {
    // Find the first available vision-capable provider with an API key configured
    for (const name of Gateway.VISION_PROVIDERS) {
      if (this.providers.has(name)) {
        const config = this.config.providers[name];
        const hasKey = config?.apiKey || process.env[config?.apiKeyEnv as string || ""];
        if (hasKey) return name;
      }
    }
    return null;
  }

  private async generateImage(prompt: string): Promise<{ dataUrl: string; text?: string } | null> {
    const geminiKey = this.config.providers.gemini?.apiKey
      || process.env[this.config.providers.gemini?.apiKeyEnv as string || ""]
      || this.config.tts?.apiKey; // Gemini TTS key as fallback

    if (!geminiKey) {
      log.error("图片生成: 未配置 Gemini API Key");
      return null;
    }

    const model = "gemini-2.5-flash-image";
    log.info(`生成图片: "${prompt.slice(0, 50)}..." (model: ${model})`);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      log.error(`Gemini 图片生成 error ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as any;
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    let text: string | undefined;
    let dataUrl: string | undefined;

    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || "image/png";
        dataUrl = `data:${mime};base64,${part.inlineData.data}`;
        log.info(`图片已生成: ${Buffer.from(part.inlineData.data, "base64").length} bytes`);
      } else if (part.text) {
        text = part.text;
      }
    }

    return dataUrl ? { dataUrl, text } : null;
  }

  /** Upload a data URL image to a public image host, returns HTTP URL */
  private async uploadImage(dataUrl: string): Promise<string | null> {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return null;

    const mimeType = match[1]!;
    const buffer = Buffer.from(match[2]!, "base64");
    const ext = mimeType.includes("png") ? "png" : "jpg";

    // Try catbox.moe (free, no auth, accessible from China)
    try {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("fileToUpload", new Blob([buffer], { type: mimeType }), `image.${ext}`);

      const res = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        const url = (await res.text()).trim();
        if (url.startsWith("http")) {
          log.info(`图片已上传: ${url}`);
          return url;
        }
      }
    } catch (err) {
      log.warn(`catbox 上传失败: ${err instanceof Error ? err.message : err}`);
    }

    // Fallback: tmpfiles.org
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mimeType }), `image.${ext}`);

      const res = await fetch("https://tmpfiles.org/api/v1/upload", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        const data = await res.json() as any;
        const url = data.data?.url?.replace("tmpfiles.org/", "tmpfiles.org/dl/");
        if (url) {
          log.info(`图片已上传: ${url}`);
          return url;
        }
      }
    } catch (err) {
      log.warn(`tmpfiles 上传失败: ${err instanceof Error ? err.message : err}`);
    }

    return null;
  }

  private async compose(ctx: Context, stack: Middleware[]): Promise<void> {
    let index = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      const fn = stack[i];
      if (!fn) return;
      await fn(ctx, () => dispatch(i + 1));
    };
    await dispatch(0);
  }

  private startWebhook(): void {
    const webhookConfig = this.config.webhook;
    if (!webhookConfig?.enabled) return;

    const port = webhookConfig.port || 4800;
    const secret = webhookConfig.secret;

    this.webhookServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Only accept POST
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      // Auth check
      if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // Parse body
      let body: string;
      try {
        body = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks).toString()));
          req.on("error", reject);
        });
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to read body" }));
        return;
      }

      let payload: { channel?: string; targetId?: string; text?: string };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const { channel: channelName, targetId, text } = payload;
      if (!channelName || !targetId || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing required fields: channel, targetId, text" }));
        return;
      }

      const channel = this.channels.get(channelName);
      if (!channel) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Channel "${channelName}" not found` }));
        return;
      }

      try {
        await channel.send({ targetId, text });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        log.info(`Webhook: 已发送消息到 ${channelName}:${targetId}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Webhook 发送失败: ${errMsg}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to send message" }));
      }
    });

    this.webhookServer.listen(port, () => {
      log.info(`Webhook 服务已启动: http://localhost:${port}`);
    });
  }

  private async handleCommand(msg: InboundMessage): Promise<void> {
    const channel = this.channels.get(msg.channel);
    if (!channel) return;

    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0]!.toLowerCase();
    const arg = parts[1];

    // Shortcut: /cc → claude, /模型名 → switch model directly
    const ALIASES: Record<string, string> = { "/cc": "claude" };
    const aliasTarget = ALIASES[cmd] || (cmd.startsWith("/") && this.providers.has(cmd.slice(1)) ? cmd.slice(1) : null);
    if (aliasTarget && this.providers.has(aliasTarget)) {
      if (!this.config.userRoutes) this.config.userRoutes = {};
      this.config.userRoutes[msg.senderId] = aliasTarget;
      if (this.config.userModelOverrides) delete this.config.userModelOverrides[msg.senderId];
      const tip = Gateway.PROVIDER_TIPS[aliasTarget] || aliasTarget;
      await channel.send({
        targetId: msg.senderId,
        text: `✓ ${tip}`,
        replyToken: msg.replyToken,
      });
      return;
    }

    switch (cmd) {
      case "/model": {
        if (!arg) {
          const currentProvider = this.config.userRoutes?.[msg.senderId] || this.config.defaultProvider;
          const modelOverride = this.config.userModelOverrides?.[msg.senderId];
          const currentDisplay = modelOverride
            ? `${currentProvider} (${modelOverride})`
            : currentProvider;
          const available = [...this.providers.keys()].join(", ");
          await channel.send({
            targetId: msg.senderId,
            text: `当前模型: ${currentDisplay}\n可用模型: ${available}\n\n用法:\n/model <名称> - 切换内置模型\n/model <vendor/model> - 第三方模型 (via OpenRouter)`,
            replyToken: msg.replyToken,
          });
        } else if (arg.includes("/")) {
          // vendor/model format → route through openrouter
          if (!this.providers.has("openrouter")) {
            await channel.send({
              targetId: msg.senderId,
              text: "需要先配置 OpenRouter API Key:\nwechat-ai set openrouter <key>\n\n获取 Key: openrouter.ai",
              replyToken: msg.replyToken,
            });
          } else {
            if (!this.config.userRoutes) this.config.userRoutes = {};
            if (!this.config.userModelOverrides) this.config.userModelOverrides = {};
            this.config.userRoutes[msg.senderId] = "openrouter";
            this.config.userModelOverrides[msg.senderId] = arg;
            await channel.send({
              targetId: msg.senderId,
              text: `✓ ${arg}\nvia OpenRouter`,
              replyToken: msg.replyToken,
            });
          }
        } else if (this.providers.has(arg.toLowerCase())) {
          const provider = arg.toLowerCase();
          if (!this.config.userRoutes) this.config.userRoutes = {};
          this.config.userRoutes[msg.senderId] = provider;
          // Clear model override when switching to built-in provider
          if (this.config.userModelOverrides) {
            delete this.config.userModelOverrides[msg.senderId];
          }
          const tip = Gateway.PROVIDER_TIPS[provider] || provider;
          await channel.send({
            targetId: msg.senderId,
            text: `✓ ${tip}`,
            replyToken: msg.replyToken,
          });
        } else {
          await channel.send({
            targetId: msg.senderId,
            text: `未知模型: ${arg}\n可用: ${[...this.providers.keys()].join(", ")}\n\n或使用第三方模型: /model <vendor/model>`,
            replyToken: msg.replyToken,
          });
        }
        break;
      }

      case "/skill": {
        const skills = this.config.skills || {};
        const skillNames = Object.keys(skills);

        if (!arg) {
          const current = this.config.userSkills?.[msg.senderId] || "无";
          const list = skillNames.length > 0
            ? skillNames.map((k) => `  ${k} - ${skills[k]!.description || "无描述"}`).join("\n")
            : "  (未配置任何技能)";
          await channel.send({
            targetId: msg.senderId,
            text: `当前技能: ${current}\n可用技能:\n${list}\n用法: /skill <名称> 或 /skill off`,
            replyToken: msg.replyToken,
          });
        } else if (arg.toLowerCase() === "off") {
          if (this.config.userSkills) {
            delete this.config.userSkills[msg.senderId];
          }
          await channel.send({
            targetId: msg.senderId,
            text: "已关闭技能，恢复默认模式",
            replyToken: msg.replyToken,
          });
        } else if (skills[arg.toLowerCase()]) {
          const skillName = arg.toLowerCase();
          if (!this.config.userSkills) this.config.userSkills = {};
          this.config.userSkills[msg.senderId] = skillName;
          const skill = skills[skillName]!;
          const info = skill.provider ? `(模型: ${skill.provider})` : "";
          await channel.send({
            targetId: msg.senderId,
            text: `已切换到技能: ${skillName} ${info}\n${skill.description || ""}`,
            replyToken: msg.replyToken,
          });
        } else {
          await channel.send({
            targetId: msg.senderId,
            text: `未知技能: ${arg}\n可用: ${skillNames.join(", ") || "无"}`,
            replyToken: msg.replyToken,
          });
        }
        break;
      }

      case "/画":
      case "/draw": {
        const prompt = msg.text.slice(cmd.length).trim();
        if (!prompt) {
          await channel.send({
            targetId: msg.senderId,
            text: "用法: /画 <描述>\n例如: /画 一只在月球上的猫",
            replyToken: msg.replyToken,
          });
          break;
        }

        await channel.send({
          targetId: msg.senderId,
          text: "正在生成图片...",
          replyToken: msg.replyToken,
        });

        try {
          const result = await this.generateImage(prompt);
          if (result) {
            // Upload to public image host to get HTTP URL
            const publicUrl = await this.uploadImage(result.dataUrl);
            const replyText = publicUrl
              ? (result.text ? `${result.text}\n${publicUrl}` : publicUrl)
              : (result.text || "图片已生成，但上传失败");
            await channel.send({
              targetId: msg.senderId,
              text: replyText,
              replyToken: msg.replyToken,
            });
          } else {
            await channel.send({
              targetId: msg.senderId,
              text: "图片生成失败，请重试",
              replyToken: msg.replyToken,
            });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`图片生成失败: ${errMsg}`);
          await channel.send({
            targetId: msg.senderId,
            text: `图片生成出错: ${errMsg}`,
            replyToken: msg.replyToken,
          });
        }
        break;
      }

      case "/help": {
        await channel.send({
          targetId: msg.senderId,
          text: [
            "wechat-ai 指令:",
            "/model [名称] - 切换AI模型",
            "/model vendor/model - 第三方模型",
            "/skill [名称] - 切换技能 (off 关闭)",
            "/画 <描述> - AI生成图片",
            "/help - 显示帮助",
            "/ping - 检查状态",
            "",
            "快捷切换模型:",
            "/cc → Claude  /qwen /deepseek /gpt 等",
            "",
            "第三方模型 (需配置 OpenRouter Key):",
            "/model google/gemini-2.5-pro",
            "/model anthropic/claude-sonnet-4",
            "/model xiaomi/mimo-v2-pro",
            "",
            "🆓 免费模型 (无需充值):",
            "/model stepfun/step-3.5-flash:free",
            "/model nvidia/nemotron-3-super-120b-a12b:free",
            "",
            "🤖 Agent 能力 (所有模型):",
            "搜索网页 · 查天气 · 查资讯 · 读写文件 · 执行命令",
            "",
            "@ 快捷方式:",
            "@模型名 <问题> - 临时用指定模型",
            "@画图 <描述> - 生成图片",
            "",
            "📖 更多: https://github.com/anxiong2025/wechat-ai/blob/main/docs/guide.md",
          ].join("\n"),
          replyToken: msg.replyToken,
        });
        break;
      }

      case "/guide":
      case "/指南": {
        const guide = [
          "📌 快捷指南:",
          "直接发消息即可对话",
          "",
          "切换模型:",
          "/cc → Claude  /qwen /deepseek /gpt",
          "",
          "第三方模型 (需先配置 OpenRouter Key):",
          "/model google/gemini-2.5-pro",
          "/model xiaomi/mimo-v2-pro",
          "",
          "🆓 免费模型 (无需充值):",
          "/model stepfun/step-3.5-flash:free",
          "",
          "🤖 所有模型均支持: 搜索 · 天气 · 资讯 · 文件 · 命令",
          "",
          "/help 查看全部指令",
          "📖 更多: https://github.com/anxiong2025/wechat-ai/blob/main/docs/guide.md",
        ].join("\n");
        await channel.send({
          targetId: msg.senderId,
          text: guide,
          replyToken: msg.replyToken,
        });
        break;
      }

      case "/ping": {
        await channel.send({
          targetId: msg.senderId,
          text: `pong (${Date.now() - msg.timestamp}ms)`,
          replyToken: msg.replyToken,
        });
        break;
      }

      default: {
        await channel.send({
          targetId: msg.senderId,
          text: `未知指令: ${cmd}，试试 /help`,
          replyToken: msg.replyToken,
        });
      }
    }
  }
}
