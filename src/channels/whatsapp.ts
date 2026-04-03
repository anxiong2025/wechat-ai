import { createLogger } from "../logger.js";
import { getAccountsDir, ensureDir } from "../config.js";
import { join } from "node:path";
import type { Channel, InboundMessage, OutboundMessage, ChannelConfig, MediaAttachment } from "../types.js";

const log = createLogger("whatsapp");

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp";

  private sock: any = null;
  private running = false;
  private onMessageCallback: ((msg: InboundMessage) => void) | null = null;
  // Saved references for reconnect
  private makeSocket: any = null;
  private authState: any = null;
  private saveCreds: any = null;
  private waVersion: any = null;
  private cacheKeyStore: any = null;

  constructor(_config: ChannelConfig) {}

  async login(): Promise<void> {}

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.onMessageCallback = onMessage;

    let baileys: any;
    try {
      // @ts-ignore — optional dependency, installed by user
      baileys = await import("@whiskeysockets/baileys");
    } catch {
      throw new Error(
        "需要安装 baileys: npm i @whiskeysockets/baileys",
      );
    }

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = baileys;

    this.makeSocket = makeWASocket?.default || makeWASocket;
    this.cacheKeyStore = makeCacheableSignalKeyStore;

    const authDir = join(getAccountsDir(), "whatsapp-auth");
    await ensureDir(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    this.authState = state;
    this.saveCreds = saveCreds;

    const { version } = await fetchLatestBaileysVersion();
    this.waVersion = version;

    this.running = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const silentLogger = {
      level: "silent",
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: () => silentLogger,
    };

    this.sock = this.makeSocket({
      version: this.waVersion,
      auth: {
        creds: this.authState.creds,
        keys: this.cacheKeyStore
          ? this.cacheKeyStore(this.authState.keys, silentLogger)
          : this.authState.keys,
      },
      logger: silentLogger,
      browser: ["wechat-ai", "Chrome", "1.0.0"],
    });

    this.sock.ev.on("creds.update", this.saveCreds);

    this.sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.info("请用 WhatsApp 扫描二维码:");
        try {
          const qrTerminal = await import("qrcode-terminal");
          (qrTerminal.default || qrTerminal).generate(qr, { small: true });
        } catch {
          console.log(qr);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (statusCode === 401) {
          log.warn("WhatsApp 已登出，请删除 ~/.wai/accounts/whatsapp-auth/ 后重新登录");
          this.running = false;
          return;
        }

        if (this.running) {
          log.info("连接断开，3秒后重连...");
          await new Promise((r) => setTimeout(r, 3000));
          if (this.running) {
            await this.connect();
          }
        }
      }

      if (connection === "open") {
        log.info("WhatsApp 已上线");
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      if (type !== "notify" || !this.onMessageCallback) return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;
        if (!msg.message) continue;

        const jid = msg.key.remoteJid!;
        const senderId = jid.replace(/@.*$/, "");

        let text = "";
        const m = msg.message;

        if (m.conversation) {
          text = m.conversation;
        } else if (m.extendedTextMessage?.text) {
          text = m.extendedTextMessage.text;
        } else if (m.imageMessage?.caption) {
          text = m.imageMessage.caption;
        } else if (m.videoMessage?.caption) {
          text = m.videoMessage.caption;
        }

        const media: MediaAttachment[] = [];
        if (m.imageMessage) {
          media.push({ type: "image", mimeType: m.imageMessage.mimetype });
        } else if (m.videoMessage) {
          media.push({ type: "video", mimeType: m.videoMessage.mimetype });
        } else if (m.audioMessage) {
          media.push({ type: "voice", mimeType: m.audioMessage.mimetype });
        } else if (m.documentMessage) {
          media.push({
            type: "file",
            mimeType: m.documentMessage.mimetype,
            fileName: m.documentMessage.fileName,
          });
        }

        const isVoice = !!m.audioMessage;
        if (!text && media.length === 0) continue;

        this.onMessageCallback({
          id: msg.key.id || String(Date.now()),
          channel: "whatsapp",
          senderId,
          senderName: msg.pushName || undefined,
          text: text || (media.length > 0 ? "[媒体消息]" : ""),
          media: media.length > 0 ? media : undefined,
          isVoice: isVoice || undefined,
          replyToken: jid,
          timestamp: (msg.messageTimestamp as number) * 1000 || Date.now(),
        });
      }
    });

    // Wait for connection
    await new Promise<void>((resolve, _reject) => {
      const timeout = setTimeout(() => {
        // Don't reject on timeout — just resolve to let other channels continue
        log.warn("WhatsApp 连接超时，将在后台继续重试");
        resolve();
      }, 120_000);

      const handler = (update: any) => {
        if (update.connection === "open") {
          clearTimeout(timeout);
          this.sock.ev.off("connection.update", handler);
          resolve();
        }
      };

      if (this.sock.user) {
        clearTimeout(timeout);
        resolve();
      } else {
        this.sock.ev.on("connection.update", handler);
      }
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp 未连接");

    const jid = msg.replyToken || `${msg.targetId}@s.whatsapp.net`;

    try {
      const chunks = this.chunkText(msg.text, 4096);
      for (const chunk of chunks) {
        await this.sock.sendMessage(jid, { text: chunk });
      }
      log.info(`已回复 (${msg.text.length} 字符) → ${jid.replace(/@.*$/, "").slice(0, 8)}...`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`发送失败: ${errMsg}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.sock) {
      this.sock.end();
      this.sock = null;
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
