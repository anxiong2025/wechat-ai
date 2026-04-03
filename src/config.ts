import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WaiConfig } from "./types.js";

const WAI_DIR = join(homedir(), ".wai");
const CONFIG_PATH = join(WAI_DIR, "config.json");

const DEFAULT_CONFIG: WaiConfig = {
  defaultProvider: "qwen",
  providers: {
    claude: {
      type: "claude-agent",
      allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
    },
    qwen: {
      type: "claw-agent",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      apiKeyEnv: "DASHSCOPE_API_KEY",
    },
    deepseek: {
      type: "claw-agent",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    gpt: {
      type: "claw-agent",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    gemini: {
      type: "claw-agent",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.0-flash",
      apiKeyEnv: "GEMINI_API_KEY",
    },
    minimax: {
      type: "claw-agent",
      baseUrl: "https://api.minimax.chat/v1",
      model: "MiniMax-Text-01",
      apiKeyEnv: "MINIMAX_API_KEY",
    },
    glm: {
      type: "claw-agent",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4-plus",
      apiKeyEnv: "GLM_API_KEY",
    },
    kimi: {
      type: "claw-agent",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "moonshot-v1-8k",
      apiKeyEnv: "MOONSHOT_API_KEY",
    },
    openrouter: {
      type: "claw-agent",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-2.5-flash",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
  },
  channels: {
    weixin: {
      type: "weixin",
      enabled: true,
    },
    discord: {
      type: "discord",
      enabled: false,
      // token: "your-bot-token",
    },
    whatsapp: {
      type: "whatsapp",
      enabled: false,
    },
  },
  systemPrompt: "You are a helpful AI assistant. Always reply in the same language the user uses. Respond concisely.",
  chunkSize: 4000,
  skills: {
    translator: {
      description: "中英翻译助手",
      systemPrompt: "You are a professional translator. Translate Chinese to English and English to Chinese. Only output the translation, no explanations.",
    },
    coder: {
      description: "编程助手",
      systemPrompt: "You are a senior software engineer. Help with coding questions. Be concise and provide code examples.",
    },
    writer: {
      description: "写作助手",
      systemPrompt: "You are a skilled writer. Help with writing, editing, and polishing text. Match the user's language.",
    },
  },
};

export async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function loadConfig(): Promise<WaiConfig> {
  await ensureDir(WAI_DIR);

  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }

  const raw = await readFile(CONFIG_PATH, "utf-8");
  const user = JSON.parse(raw) as Partial<WaiConfig>;

  // Deep merge: default providers + user providers (user overrides per provider)
  const providers = { ...DEFAULT_CONFIG.providers };
  if (user.providers) {
    for (const [key, val] of Object.entries(user.providers)) {
      providers[key] = val;
    }
  }

  const config = { ...DEFAULT_CONFIG, ...user, providers } as WaiConfig;

  // Migrate: zhipu → glm
  if (config.providers.zhipu) {
    if (!config.providers.glm) {
      config.providers.glm = { ...config.providers.zhipu, apiKeyEnv: "GLM_API_KEY" };
    }
    delete config.providers.zhipu;
    if (config.defaultProvider === "zhipu") config.defaultProvider = "glm";
    await saveConfig(config);
  }

  return config;
}

export async function saveConfig(config: WaiConfig): Promise<void> {
  await ensureDir(WAI_DIR);
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getDataDir(): string {
  return WAI_DIR;
}

export function getAccountsDir(): string {
  return join(WAI_DIR, "accounts");
}
