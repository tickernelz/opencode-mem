import type { PluginModule } from "@opencode-ai/plugin";
import pkg from "../package.json";
const { OpenCodeMemPlugin } = await import("./index.js");

export const id =
  typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "opencode-mem";
export { OpenCodeMemPlugin };
export default { id, server: OpenCodeMemPlugin } satisfies PluginModule;
