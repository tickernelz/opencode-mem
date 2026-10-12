import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";

let tmpDir: string;

describe("V2 skills bridge helpers", () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-v2-skills-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = tmpDir;
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    skillsManager.reset();
  });

  afterEach(async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    skillsManager.reset();
    await tursoConnectionManager.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("exposes absolute skill paths for OpenCode Skill.Info", async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    await skillsManager.create({
      id: "bridge-demo",
      name: "Bridge Demo",
      description: "demo",
      content: "Do the thing.",
    });
    const path = skillsManager.skillPath("bridge-demo");
    expect(path.startsWith("/")).toBe(true);
    expect(path.endsWith("bridge-demo/SKILL.md")).toBe(true);
  });

  it("lists only enabled skills for registration filtering", async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    await skillsManager.create({
      id: "on",
      name: "On",
      content: "a",
      enabled: true,
    });
    await skillsManager.create({
      id: "off",
      name: "Off",
      content: "b",
      enabled: false,
    });
    const enabled = await skillsManager.list({ enabledOnly: true });
    expect(enabled.map((s) => s.id)).toEqual(["on"]);
  });
});
