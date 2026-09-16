import { describe, expect, it } from "bun:test";

describe("OpenCode v2 plugin-loader contract", () => {
  it("exports a native v2 plugin definition", async () => {
    const mod = await import(new URL("../dist/v2/plugin.js", import.meta.url).href);
    expect(mod.default.id).toBe("opencode-mem");
    expect(typeof mod.default.setup).toBe("function");
  });
});
