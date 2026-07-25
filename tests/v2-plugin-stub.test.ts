/**
 * Live smoke for the inactive OpenCode V2 plugin stub (#173).
 * Does not wire V2 into package exports — only verifies the contract loads.
 */

import { describe, expect, it } from "bun:test";
import { define } from "@opencode-ai/plugin/v2/promise";

describe("OpenCode V2 plugin stub contract", () => {
  it("loads define() from @opencode-ai/plugin/v2/promise", () => {
    expect(typeof define).toBe("function");
  });

  it("src/v2/plugin.ts exports a defined plugin with id and setup", async () => {
    const mod = await import("../src/v2/plugin.js");
    expect(mod.openCodeMemV2Plugin.id).toBe("opencode-mem");
    expect(typeof mod.openCodeMemV2Plugin.setup).toBe("function");
    expect(mod.default).toBe(mod.openCodeMemV2Plugin);
  });

  it("setup() runs against a minimal mock PluginContext", async () => {
    const { openCodeMemV2Plugin } = await import("../src/v2/plugin.js");
    const noopReg = { dispose: async () => {} };
    const reload = { reload: async () => {} };
    const hook = () => async () => noopReg;

    await openCodeMemV2Plugin.setup({
      options: {},
      agent: { transform: hook(), ...reload },
      aisdk: { wrapLanguageModel: hook() } as any,
      catalog: { transform: hook(), ...reload },
      command: { transform: hook(), ...reload },
      integration: {
        transform: hook(),
        connection: {
          active: async () => undefined,
          resolve: async () => undefined,
        },
        ...reload,
      },
      plugin: {
        add: async () => {},
        remove: async () => {},
      },
      reference: { transform: hook(), ...reload },
      skill: { transform: hook(), ...reload },
    } as any);
  });

  it("package.json main still points at V1 dist/plugin.js", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(pkg.main).toBe("dist/plugin.js");
    expect(pkg.exports?.["."]?.import).toBe("./dist/plugin.js");
    expect(pkg.exports?.["./v2"]).toBeUndefined();
  });
});
