import { createLogger } from "../logger.js";
import type { Channel, InboundMessage, OutboundMessage, ChannelConfig } from "../types.js";

const log = createLogger("discord");

export class DiscordChannel implements Channel {
  readonly name = "discord";

  private client: any = null;
  private config: ChannelConfig;
  private running = false;

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  async login(): Promise<void> {
    // Login happens in start() via client.login()
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    const token = this.config.token as string;
    if (!token) {
      throw new Error("Discord Bot Token 未配置。请在 ~/.wai/config.json 的 channels.discord.token 中设置");
    }

    let discordjs: any;
    try {
      // @ts-ignore — optional dependency, installed by user
      discordjs = await import("discord.js");
    } catch {
      throw new Error(
        "需要安装 discord.js: npm i -g discord.js\n"
        + "或在项目中: npm i discord.js",
      );
    }

    const { Client, GatewayIntentBits, Partials } = discordjs;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel], // needed for DMs
    });

    this.running = true;

    this.client.on("ready", () => {
      const tag = this.client.user?.tag || "unknown";
      log.info(`已上线: ${tag}`);
    });

    this.client.on("messageCreate", async (message: any) => {
      if (!this.running) return;
      // Ignore bot's own messages
      if (message.author.bot) return;

      const isDM = !message.guild;
      const botMentioned = message.mentions?.has(this.client.user);

      // Respond to: DMs, or @mentions in servers
      // If respondToAll is true, respond to all messages in allowed channels
      const respondToAll = this.config.respondToAll as boolean;
      const allowedChannels = this.config.allowedChannels as string[] | undefined;

      if (!isDM && !botMentioned && !respondToAll) return;

      // Filter by allowed channels if configured
      if (allowedChannels?.length && !isDM && !allowedChannels.includes(message.channel.id)) {
        return;
      }

      // Strip bot mention from text
      let text = message.content || "";
      if (botMentioned) {
        text = text.replace(/<@!?\d+>/g, "").trim();
      }

      // Handle image attachments
      const media = message.attachments
        ?.filter((a: any) => a.contentType?.startsWith("image/"))
        .map((a: any) => ({
          type: "image" as const,
          url: a.url,
          mimeType: a.contentType,
          fileName: a.name,
          size: a.size,
        })) || [];

      if (!text && media.length === 0) return;

      // Use channel ID + user ID as sender for isolation
      const senderId = isDM ? message.author.id : `${message.channel.id}:${message.author.id}`;

      onMessage({
        id: message.id,
        channel: "discord",
        senderId,
        senderName: message.author.username,
        text: text || (media.length > 0 ? "[媒体消息]" : ""),
        media: media.length > 0 ? media : undefined,
        replyToken: message.channel.id, // channel ID for replying
        timestamp: message.createdTimestamp || Date.now(),
      });
    });

    await this.client.login(token);
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.client) throw new Error("Discord 未连接");

    // replyToken contains the channel ID
    const channelId = msg.replyToken || msg.targetId.split(":")[0];
    if (!channelId) {
      log.error("无法确定回复频道");
      return;
    }

    try {
      // Try to find channel - could be a DM user ID or guild channel ID
      let channel = this.client.channels.cache.get(channelId);
      if (!channel) {
        channel = await this.client.channels.fetch(channelId).catch(() => null);
      }

      // If channelId is actually a user ID (DM), create DM channel
      if (!channel) {
        const user = await this.client.users.fetch(channelId).catch(() => null);
        if (user) {
          channel = await user.createDM();
        }
      }

      if (!channel || !("send" in channel)) {
        log.error(`找不到频道: ${channelId}`);
        return;
      }

      // Discord has 2000 char limit per message
      const chunks = this.chunkText(msg.text, 2000);
      for (const chunk of chunks) {
        await (channel as any).send(chunk);
      }

      log.info(`已回复 (${msg.text.length} 字符)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`发送失败: ${errMsg}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    log.info("已停止");
  }

  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let breakAt = remaining.lastIndexOf("\n", maxLen);
      if (breakAt <= 0) breakAt = maxLen;
      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt);
    }
    return chunks;
  }
}
