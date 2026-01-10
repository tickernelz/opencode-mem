#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

if (!existsSync(join(projectRoot, "node_modules"))) {
  console.error("Error: node_modules not found. Run 'bun install' first.");
  process.exit(1);
}

process.chdir(projectRoot);

const { OpenCodeMemPlugin } = await import("./index.js");
export { OpenCodeMemPlugin };
export default OpenCodeMemPlugin;
