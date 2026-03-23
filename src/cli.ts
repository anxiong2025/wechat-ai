#!/usr/bin/env node

import { loadConfig, saveConfig } from "./config.js";
import { Gateway } from "./gateway.js";
import { setLogLevel, createLogger } from "./logger.js";

const log = createLogger("cli");

const HELP = `
  \x1b[1mwechat-ai\x1b[0m — WeChat AI Bot

  \x1b[1m命令:\x1b[0m
    wechat-ai                        启动 (首次自动扫码登录)
    wechat-ai set <provider> <key>   设置模型 API Key
    wechat-ai use <provider>         设置默认模型
    wechat-ai config                 查看当前配置
    wechat-ai update                 更新到最新版
    wechat-ai help                   显示帮助

  \x1b[1m设置 API Key:\x1b[0m
    wechat-ai set qwen sk-xxx        设置通义千问 Key
    wechat-ai set deepseek sk-xxx    设置 DeepSeek Key
    wechat-ai set claude sk-xxx      设置 Claude Key

  \x1b[1m设置默认模型:\x1b[0m
    wechat-ai use qwen               默认使用 Qwen
    wechat-ai use deepseek           默认使用 DeepSeek

  \x1b[1m微信指令:\x1b[0m
    /model             查看当前模型
    /model qwen        切换到 Qwen
    /model deepseek    切换到 DeepSeek
    /help              显示帮助
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const logLevel = (process.env.WAI_LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error";
  setLogLevel(logLevel);

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const config = await loadConfig();

  switch (command) {
    case "set": {
      const provider = args[1];
      const apiKey = args[2];

      if (!provider || !apiKey) {
        console.log("用法: wechat-ai set <provider> <key>");
        console.log("示例: wechat-ai set qwen sk-xxx");
        process.exit(1);
      }

      if (!config.providers[provider]) {
        console.log(`未知模型: ${provider}`);
        console.log(`可用: ${Object.keys(config.providers).join(", ")}`);
        process.exit(1);
      }

      config.providers[provider]!.apiKey = apiKey;
      await saveConfig(config);
      console.log(`\x1b[32m✓\x1b[0m 已保存 ${provider} 的 API Key`);
      break;
    }

    case "use": {
      const provider = args[1];

      if (!provider) {
        console.log(`当前默认模型: ${config.defaultProvider}`);
        console.log(`可用: ${Object.keys(config.providers).join(", ")}`);
        break;
      }

      if (!config.providers[provider]) {
        console.log(`未知模型: ${provider}`);
        console.log(`可用: ${Object.keys(config.providers).join(", ")}`);
        process.exit(1);
      }

      config.defaultProvider = provider;
      await saveConfig(config);
      console.log(`\x1b[32m✓\x1b[0m 默认模型已切换到 ${provider}`);
      break;
    }

    case "update": {
      const { execSync } = await import("node:child_process");
      console.log("正在更新 wechat-ai...");
      try {
        execSync("npm i -g wechat-ai@latest", { stdio: "inherit" });
        console.log("\x1b[32m✓\x1b[0m 更新完成");
      } catch {
        console.error("\x1b[31m✗\x1b[0m 更新失败，请手动执行: npm i -g wechat-ai@latest");
        process.exit(1);
      }
      break;
    }

    case "config": {
      // Hide API keys in output
      const display = JSON.parse(JSON.stringify(config));
      for (const p of Object.values(display.providers)) {
        const prov = p as Record<string, unknown>;
        if (prov.apiKey && typeof prov.apiKey === "string") {
          prov.apiKey = prov.apiKey.slice(0, 6) + "..." + prov.apiKey.slice(-4);
        }
      }
      console.log(JSON.stringify(display, null, 2));
      break;
    }

    default: {
      const gateway = new Gateway(config);
      gateway.init();

      const shutdown = async () => {
        await gateway.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      log.info("启动 wechat-ai...");
      await gateway.start();
      break;
    }
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
