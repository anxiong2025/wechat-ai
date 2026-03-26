import { createLogger } from "../logger.js";
import { getAccountsDir, ensureDir } from "../config.js";
import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID, createDecipheriv } from "node:crypto";
import type { Channel, InboundMessage, OutboundMessage, ChannelConfig, MediaAttachment } from "../types.js";

const log = createLogger("weixin");

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "1.0.3";
const API_TIMEOUT_MS = 15_000;

// ── Message constants (from openclaw-weixin protocol) ──
const MessageType = { USER: 1, BOT: 2 } as const;
const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

// ── Types ──

interface WeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;  // base64-encoded
}

interface WeixinMessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: {
    media?: CDNMedia;
    thumb_media?: CDNMedia;
    /** Raw AES key as hex string (preferred for images) */
    aeskey?: string;
    url?: string;
  };
  voice_item?: {
    media?: CDNMedia;
    /** Voice-to-text from WeChat (if available) */
    text?: string;
    encode_type?: number;
    playtime?: number;
  };
  file_item?: {
    media?: CDNMedia;
    file_name?: string;
  };
  video_item?: {
    media?: CDNMedia;
  };
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  item_list?: WeixinMessageItem[];
  create_time_ms?: number;
}

interface GetUpdatesResponse {
  ret?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

// ── Weixin Channel ──

export class WeixinChannel implements Channel {
  readonly name = "weixin";

  private account: WeixinAccount | null = null;
  private syncBuf = "";
  private running = false;
  private abortController: AbortController | null = null;
  private config: ChannelConfig;
  // Cache typing_ticket per user
  private typingTickets = new Map<string, string>();
  // Last known context_token per user (for startup greeting)
  private lastTokens = new Map<string, string>();

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  // ── Auth ──

  async login(): Promise<void> {
    const baseUrl = (this.config.baseUrl as string) || DEFAULT_BASE_URL;
    log.debug("获取二维码中...");

    const qrRes = await this.api(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3", null, {
      method: "GET",
      timeout: 10_000,
    });

    if (qrRes.ret !== 0) {
      throw new Error(`获取二维码失败: ${qrRes.errmsg || qrRes.ret}`);
    }

    const qrUrl: string = qrRes.qrcode_img_content || qrRes.data?.qrcode_img_content;
    const qrCode: string = qrRes.qrcode || qrRes.data?.qrcode;

    if (!qrUrl || !qrCode) {
      throw new Error(`二维码响应缺少字段: ${JSON.stringify(qrRes)}`);
    }

    log.info("请用微信扫描二维码:");
    console.log();
    try {
      const qrTerminal = await import("qrcode-terminal");
      (qrTerminal.default || qrTerminal).generate(qrUrl, { small: true });
    } catch {
      console.log(`  ${qrUrl}`);
    }
    console.log();

    log.info("等待扫码...");

    let attempts = 0;
    while (attempts < 60) {
      const statusRes = await this.api(
        baseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`,
        null,
        { method: "GET", timeout: 40_000 },
      );

      const status = statusRes.data?.status || statusRes.status;

      if (status === "confirmed") {
        const data = statusRes.data || statusRes;
        const accountId: string = data.ilink_bot_id || data.bot_id;
        const token: string = data.bot_token || data.token;

        if (!accountId || !token) {
          throw new Error("登录成功但缺少凭证");
        }

        this.account = {
          accountId,
          token,
          baseUrl: data.baseurl || baseUrl,
          userId: data.ilink_user_id,
        };

        await this.saveAccount();
        log.info(`登录成功！账号: ${accountId.slice(0, 8)}...`);
        return;
      }

      if (status === "scaned") {
        log.info("已扫码，等待确认...");
      }

      if (status === "expired") {
        log.warn("二维码已过期");
        throw new Error("二维码已过期");
      }

      attempts++;
      await sleep(500);
    }

    throw new Error("登录超时");
  }

  // ── Message loop ──

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    if (!this.account) {
      await this.loadAccount();
    }

    // If we have a saved account and running interactively, ask whether to reuse it
    if (this.account && !process.env.WAI_DAEMON) {
      const reuse = await this.promptReuse();
      if (!reuse) {
        log.info("清除旧账号，重新扫码登录...");
        await this.clearAccount();
        this.account = null;
      }
    }

    if (!this.account) {
      log.info("首次使用，开始登录...");
      await this.login();
    }

    await this.loadSyncBuf();
    await this.loadLastTokens();
    this.running = true;
    log.info(`已上线 (${this.account!.accountId.slice(0, 8)}...)`);

    // Send startup greeting to all known users
    await this.sendStartupGreeting();

    while (this.running) {
      try {
        this.abortController = new AbortController();
        const res = await this.getUpdates();

        if (res.ret === -14) {
          log.warn("会话过期，重新登录...");
          this.account = null;
          await this.login();
          continue;
        }

        if (res.ret && res.ret !== 0) {
          log.warn(`拉取消息失败: ${res.errmsg || JSON.stringify(res)}`);
          await sleep(5000);
          continue;
        }

        if (res.get_updates_buf) {
          this.syncBuf = res.get_updates_buf;
          await this.saveSyncBuf();
        }

        if (res.msgs && res.msgs.length > 0) {
          for (const msg of res.msgs) {
            const content = this.extractContent(msg);
            if (!content || !msg.from_user_id) continue;

            // Download media: resolve encrypt_query_param → base64 data URL
            const resolvedMedia: MediaAttachment[] = [];
            for (const m of content.media) {
              if (m.url && !m.url.startsWith("data:")) {
                // Find the matching item to get aeskey
                const encryptParam = m.url;
                const item = msg.item_list?.find((i) =>
                  i.image_item?.media?.encrypt_query_param === encryptParam
                  || i.voice_item?.media?.encrypt_query_param === encryptParam
                  || i.file_item?.media?.encrypt_query_param === encryptParam
                  || i.video_item?.media?.encrypt_query_param === encryptParam,
                );

                // For images: prefer image_item.aeskey (hex), fallback to media.aes_key (base64)
                let aeskey: string | undefined;
                if (item?.image_item?.aeskey) {
                  aeskey = item.image_item.aeskey;  // hex format
                } else if (item?.image_item?.media?.aes_key) {
                  aeskey = `base64:${item.image_item.media.aes_key}`;
                } else if (item?.voice_item?.media?.aes_key) {
                  aeskey = `base64:${item.voice_item.media.aes_key}`;
                } else if (item?.file_item?.media?.aes_key) {
                  aeskey = `base64:${item.file_item.media.aes_key}`;
                } else if (item?.video_item?.media?.aes_key) {
                  aeskey = `base64:${item.video_item.media.aes_key}`;
                }

                log.debug(`下载媒体 type=${m.type}, aeskey=${aeskey ? "有" : "无"}`);
                const dataUrl = await this.downloadMedia("", aeskey, encryptParam);
                if (dataUrl) {
                  m.url = dataUrl;
                  resolvedMedia.push(m);
                } else {
                  log.warn(`媒体下载失败，跳过`);
                }
              } else {
                resolvedMedia.push(m);
              }
            }
            content.media = resolvedMedia;

            const mediaInfo = content.media.length > 0
              ? ` +${content.media.map((m) => m.type).join(",")}`
              : "";
            log.info(`收到消息 [${msg.from_user_id.slice(0, 8)}...]: ${content.text.slice(0, 50)}${mediaInfo}`);
            // Save context_token for startup greeting
            if (msg.context_token && msg.from_user_id) {
              this.lastTokens.set(msg.from_user_id, msg.context_token);
              this.saveLastTokens();
            }

            onMessage({
              id: String(msg.message_id || msg.seq || Date.now()),
              channel: "weixin",
              senderId: msg.from_user_id,
              text: content.text,
              media: content.media.length > 0 ? content.media : undefined,
              isVoice: content.isVoice || undefined,
              replyToken: msg.context_token,
              timestamp: msg.create_time_ms || Date.now(),
            });
          }
        }
      } catch (err) {
        if (!this.running) break;
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("AbortError")) continue;
        log.error(`轮询出错: ${message}`);
        await sleep(3000);
      }
    }
  }

  // ── Send typing indicator ──

  async sendTyping(userId: string, contextToken?: string): Promise<void> {
    if (!this.account) return;

    try {
      // Get typing_ticket if not cached
      let ticket = this.typingTickets.get(userId);
      if (!ticket) {
        const configRes = await this.api(this.account.baseUrl, "ilink/bot/getconfig", {
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: { channel_version: CHANNEL_VERSION },
        }, { timeout: 10_000 });

        ticket = configRes.typing_ticket;
        if (ticket) {
          this.typingTickets.set(userId, ticket);
        }
      }

      if (!ticket) return;

      await this.api(this.account.baseUrl, "ilink/bot/sendtyping", {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: 1,
        base_info: { channel_version: CHANNEL_VERSION },
      }, { timeout: 10_000 });

      log.debug(`已发送输入状态给 ${userId.slice(0, 8)}...`);
    } catch {
      // typing 失败不影响主流程
    }
  }

  // ── Send message ──

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.account) throw new Error("未登录");

    // Try sending voice if audio buffer is provided
    if (msg.voice) {
      const sent = await this.sendVoice(msg.targetId, msg.voice, msg.replyToken);
      if (sent) return;
      log.warn("语音发送失败，降级为文本");
    }

    const chunks = this.chunkText(msg.text, 4000);

    for (const chunk of chunks) {
      const body = {
        msg: {
          from_user_id: "",
          to_user_id: msg.targetId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: msg.replyToken || undefined,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      };

      const res = await this.api(
        this.account.baseUrl,
        "ilink/bot/sendmessage",
        body,
        { timeout: API_TIMEOUT_MS },
      );

      if (res.ret && res.ret !== 0) {
        log.error(`发送失败: ret=${res.ret} ${res.errmsg || JSON.stringify(res)}`);
      } else {
        log.debug(`文本已发送 (${chunk.length} 字符)`);
      }
    }
  }

  /** Upload media and send as voice message */
  private async sendVoice(targetId: string, audio: Buffer, replyToken?: string): Promise<boolean> {
    if (!this.account) return false;

    try {
      // Upload media to get a media reference
      const mediaRef = await this.uploadMedia(audio, "voice", "audio/mpeg");
      if (!mediaRef) return false;

      const body = {
        msg: {
          from_user_id: "",
          to_user_id: targetId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: replyToken || undefined,
          item_list: [{
            type: MessageItemType.VOICE,
            voice_item: {
              media: mediaRef,
              playtime: estimatePlaytime(audio.length),
            },
          }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      };

      const res = await this.api(
        this.account.baseUrl,
        "ilink/bot/sendmessage",
        body,
        { timeout: API_TIMEOUT_MS },
      );

      if (res.ret && res.ret !== 0) {
        log.error(`语音发送失败: ${res.errmsg || JSON.stringify(res)}`);
        return false;
      }

      log.debug("语音消息已发送");
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`语音发送异常: ${errMsg}`);
      return false;
    }
  }

  /** Upload media to WeChat, returns media reference for use in sendmessage */
  private async uploadMedia(
    data: Buffer,
    type: "voice" | "image" | "video" | "file",
    mimeType: string,
  ): Promise<CDNMedia | null> {
    if (!this.account) return null;

    try {
      const formData = new FormData();
      const blob = new Blob([data], { type: mimeType });
      const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.split("/")[1] || "bin";
      formData.append("media", blob, `upload.${ext}`);
      formData.append("type", type);

      const url = `${this.account.baseUrl.replace(/\/$/, "")}/ilink/bot/uploadmedia`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "AuthorizationType": "ilink_bot_token",
          "Authorization": `Bearer ${this.account.token}`,
          "X-WECHAT-UIN": randomUin(),
        },
        body: formData,
        signal: AbortSignal.timeout(30_000),
      });

      const result = await res.json() as any;

      if (result.ret && result.ret !== 0) {
        log.error(`媒体上传失败: ${result.errmsg || JSON.stringify(result)}`);
        return null;
      }

      // Extract media reference from response
      const media: CDNMedia = {
        encrypt_query_param: result.encrypt_query_param || result.media?.encrypt_query_param || result.media_id,
      };

      if (!media.encrypt_query_param) {
        log.warn(`媒体上传: 未返回有效引用, 响应: ${JSON.stringify(result).slice(0, 200)}`);
        return null;
      }

      log.debug(`媒体上传成功: ${media.encrypt_query_param.slice(0, 20)}...`);
      return media;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`媒体上传异常: ${errMsg}`);
      return null;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    log.info("已停止");
  }

  // ── Internal ──

  private async getUpdates(): Promise<GetUpdatesResponse> {
    if (!this.account) throw new Error("未登录");

    return this.api(this.account.baseUrl, "ilink/bot/getupdates", {
      get_updates_buf: this.syncBuf,
      base_info: { channel_version: CHANNEL_VERSION },
    }, { timeout: 50_000 });
  }

  /** Download media from WeChat CDN, decrypt, and return as base64 data URL */
  async downloadMedia(_mediaId: string, aeskey?: string, encryptParam?: string): Promise<string | null> {
    if (!encryptParam) {
      log.warn("媒体缺少 encrypt_query_param，无法下载");
      return null;
    }

    try {
      // Build CDN download URL
      const cdnUrl = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptParam)}`;
      log.debug(`下载媒体: ${cdnUrl.slice(0, 80)}...`);

      const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        log.error(`CDN 下载失败: ${res.status} ${res.statusText}`);
        return null;
      }

      let buffer = Buffer.from(await res.arrayBuffer());
      log.debug(`CDN 下载完成: ${buffer.length} bytes`);

      // Decrypt with AES-128-ECB if aeskey is provided
      if (aeskey) {
        try {
          let key: Buffer;
          if (aeskey.startsWith("base64:")) {
            // base64-encoded key (from media.aes_key)
            const decoded = Buffer.from(aeskey.slice(7), "base64");
            // Could be raw 16 bytes or hex string of 32 chars
            if (decoded.length === 16) {
              key = decoded;
            } else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
              key = Buffer.from(decoded.toString("ascii"), "hex");
            } else {
              throw new Error(`unexpected aes_key length: ${decoded.length}`);
            }
          } else {
            // hex-encoded key (from image_item.aeskey)
            key = Buffer.from(aeskey, "hex");
          }
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
          log.debug(`AES 解密完成: ${buffer.length} bytes`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(`AES 解密失败 (尝试使用原始数据): ${errMsg}`);
        }
      }

      // Detect content type from magic bytes
      const contentType = detectImageType(buffer);
      const base64 = buffer.toString("base64");
      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`媒体下载失败: ${errMsg}`);
      return null;
    }
  }

  private extractContent(msg: WeixinMessage): { text: string; media: MediaAttachment[]; isVoice: boolean } | null {
    if (!msg.item_list?.length) return null;

    const texts: string[] = [];
    const media: MediaAttachment[] = [];
    let isVoice = false;

    for (const item of msg.item_list) {
      switch (item.type) {
        case MessageItemType.TEXT:
          if (item.text_item?.text) texts.push(item.text_item.text);
          break;
        case MessageItemType.IMAGE: {
          const img = item.image_item;
          if (img?.media?.encrypt_query_param) {
            // Use encrypt_query_param as the "url" key — downloadMedia resolves it
            media.push({ type: "image", url: img.media.encrypt_query_param });
          }
          break;
        }
        case MessageItemType.VOICE: {
          isVoice = true;
          const voice = item.voice_item;
          // WeChat may provide voice-to-text directly
          if (voice?.text) {
            texts.push(voice.text);
            log.debug(`语音自带转文字: "${voice.text.slice(0, 50)}"`);
          } else if (voice?.media?.encrypt_query_param) {
            media.push({ type: "voice", url: voice.media.encrypt_query_param });
          }
          break;
        }
        case MessageItemType.FILE: {
          const file = item.file_item;
          if (file?.media?.encrypt_query_param) {
            media.push({ type: "file", url: file.media.encrypt_query_param, fileName: file.file_name });
          }
          break;
        }
        case MessageItemType.VIDEO: {
          const video = item.video_item;
          if (video?.media?.encrypt_query_param) {
            media.push({ type: "video", url: video.media.encrypt_query_param });
          }
          break;
        }
      }
    }

    if (texts.length === 0 && media.length === 0) return null;
    const text = texts.join("\n") || (media.length > 0 ? "[媒体消息]" : "");

    return { text, media: media.length > 0 ? media : [], isVoice };
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

  private async api(
    baseUrl: string,
    path: string,
    body: unknown,
    opts: { method?: string; timeout?: number } = {},
  ): Promise<any> {
    const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
    const method = opts.method || "POST";
    const bodyStr = body ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.account?.token) {
      headers["AuthorizationType"] = "ilink_bot_token";
      headers["Authorization"] = `Bearer ${this.account.token}`;
      headers["X-WECHAT-UIN"] = randomUin();
      if (bodyStr) {
        headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || API_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn(`HTTP ${res.status} ${res.statusText} ← ${path}`);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        log.warn(`非 JSON 响应 ← ${path}: ${text.slice(0, 200)}`);
        return { ret: -999, errmsg: `HTTP ${res.status}: ${text.slice(0, 100)}` };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Persistence ──

  private accountFile(): string {
    return join(getAccountsDir(), "weixin.json");
  }

  private syncFile(): string {
    return join(getAccountsDir(), "weixin-sync.json");
  }

  private async saveAccount(): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.accountFile(), JSON.stringify(this.account, null, 2));
  }

  private async loadAccount(): Promise<void> {
    const path = this.accountFile();
    if (!existsSync(path)) return;
    try {
      const raw = await readFile(path, "utf-8");
      this.account = JSON.parse(raw);
      log.debug(`已加载账号: ${this.account!.accountId.slice(0, 8)}...`);
    } catch {
      log.warn("加载账号失败");
    }
  }

  private async clearAccount(): Promise<void> {
    for (const file of [this.accountFile(), this.syncFile()]) {
      if (existsSync(file)) {
        await unlink(file);
      }
    }
    for (const f of ["weixin-tokens.json", "weixin-guide-sent.json"]) {
      const p = join(getAccountsDir(), f);
      if (existsSync(p)) await unlink(p);
    }
  }

  private promptReuse(): Promise<boolean> {
    return new Promise((resolve) => {
      const id = this.account!.accountId;
      const display = id.length > 12 ? id.slice(0, 6) + "..." + id.slice(-4) : id;
      const options = ["继续使用当前账号", "重新扫码登录"];
      let selected = 0;

      const render = () => {
        // Move cursor up to redraw (except first render)
        process.stdout.write(`\x1b[${options.length}A`);
        for (let i = 0; i < options.length; i++) {
          const prefix = i === selected ? "\x1b[36m❯\x1b[0m" : " ";
          const text = i === selected ? `\x1b[1m${options[i]}\x1b[0m` : `\x1b[2m${options[i]}\x1b[0m`;
          process.stdout.write(`\x1b[2K  ${prefix} ${text}\n`);
        }
      };

      console.log(`\x1b[32m?\x1b[0m 检测到已登录账号 (${display})，请选择: \x1b[2m(↑↓ 选择, 回车确认)\x1b[0m`);
      // Print initial placeholders
      for (let i = 0; i < options.length; i++) {
        console.log();
      }
      render();

      if (!process.stdin.isTTY) {
        // Non-interactive: default to reuse
        resolve(true);
        return;
      }

      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (data: Buffer) => {
        const key = data.toString();
        if (key === "\x1b[A" || key === "k") {
          // Up
          selected = (selected - 1 + options.length) % options.length;
          render();
        } else if (key === "\x1b[B" || key === "j") {
          // Down
          selected = (selected + 1) % options.length;
          render();
        } else if (key === "\r" || key === "\n") {
          // Enter
          cleanup();
          resolve(selected === 0);
        } else if (key === "\x03") {
          // Ctrl+C
          cleanup();
          process.exit(0);
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      };

      process.stdin.on("data", onData);
    });
  }

  private async saveSyncBuf(): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.syncFile(), JSON.stringify({ get_updates_buf: this.syncBuf }));
  }

  private async loadSyncBuf(): Promise<void> {
    const path = this.syncFile();
    if (!existsSync(path)) return;
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw);
      this.syncBuf = data.get_updates_buf || "";
    } catch {
      // fresh start
    }
  }

  // ── Startup greeting ──

  private guideSentFile(): string {
    return join(getAccountsDir(), "weixin-guide-sent.json");
  }

  private async loadGuideSent(): Promise<Set<string>> {
    const path = this.guideSentFile();
    if (!existsSync(path)) return new Set();
    try {
      const raw = await readFile(path, "utf-8");
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  private async saveGuideSent(sent: Set<string>): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.guideSentFile(), JSON.stringify([...sent]));
  }

  private async sendStartupGreeting(): Promise<void> {
    if (this.lastTokens.size === 0) return;

    const greeting = "Hey! I'm back online and ready to chat. Send me a message anytime! 👋";
    const guide = [
      "📌 快捷指南:",
      "直接发消息即可对话",
      "/cc 切Claude（/qwen /deepseek /gpt 可切模型）",
      "@模型名 问题 → 临时用指定模型",
      "/help 查看全部指令",
    ].join("\n");

    const guideSent = await this.loadGuideSent();
    log.debug(`发送启动问候给 ${this.lastTokens.size} 个用户...`);

    for (const [userId, token] of this.lastTokens) {
      try {
        await this.send({ targetId: userId, text: greeting, replyToken: token });
        if (!guideSent.has(userId)) {
          await new Promise((r) => setTimeout(r, 500));
          await this.send({ targetId: userId, text: guide, replyToken: token });
          guideSent.add(userId);
        }
        log.debug(`已问候 ${userId.slice(0, 8)}...`);
      } catch {
        log.warn(`问候失败 ${userId.slice(0, 8)}... (token 可能过期)`);
      }
    }

    await this.saveGuideSent(guideSent);
  }

  // ── Last token persistence ──

  private lastTokensFile(): string {
    return join(getAccountsDir(), "weixin-tokens.json");
  }

  private async saveLastTokens(): Promise<void> {
    try {
      await ensureDir(getAccountsDir());
      const data = Object.fromEntries(this.lastTokens);
      await writeFile(this.lastTokensFile(), JSON.stringify(data));
    } catch {
      // non-critical
    }
  }

  private async loadLastTokens(): Promise<void> {
    const path = this.lastTokensFile();
    if (!existsSync(path)) return;
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") this.lastTokens.set(k, v);
      }
      log.debug(`已加载 ${this.lastTokens.size} 个用户 token`);
    } catch {
      // fresh start
    }
  }
}

// ── Helpers ──

function randomUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function generateClientId(): string {
  return `wai-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Estimate voice playtime in ms from mp3 buffer size (rough: ~16kbps) */
function estimatePlaytime(byteSize: number): number {
  return Math.round((byteSize * 8) / 16000 * 1000);
}

function detectImageType(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "image/jpeg"; // default
}
