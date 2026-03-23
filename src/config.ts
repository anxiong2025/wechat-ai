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
      type: "openai-compatible",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      apiKeyEnv: "DASHSCOPE_API_KEY",
    },
    deepseek: {
      type: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    gpt: {
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    gemini: {
      type: "openai-compatible",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.0-flash",
      apiKeyEnv: "GEMINI_API_KEY",
    },
    minimax: {
      type: "openai-compatible",
      baseUrl: "https://api.minimax.chat/v1",
      model: "MiniMax-Text-01",
      apiKeyEnv: "MINIMAX_API_KEY",
    },
    glm: {
      type: "openai-compatible",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4-plus",
      apiKeyEnv: "GLM_API_KEY",
    },
  },
  channels: {
    weixin: {
      type: "weixin",
      enabled: true,
    },
  },
  systemPrompt: "You are a helpful AI assistant. Respond concisely.",
  chunkSize: 4000,
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
