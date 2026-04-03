import { defineConfig } from "tsup";
import { writeFileSync, readFileSync } from "node:fs";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: "esm",
  target: "node22",
  platform: "node",
  external: ["discord.js", "@whiskeysockets/baileys"],
  splitting: true,
  clean: true,
  dts: true,
  sourcemap: true,
  onSuccess: async () => {
    // Add shebang only to CLI entry
    const cliPath = "dist/cli.js";
    const content = readFileSync(cliPath, "utf-8");
    if (!content.startsWith("#!")) {
      writeFileSync(cliPath, `#!/usr/bin/env node\n${content}`);
    }
  },
});
