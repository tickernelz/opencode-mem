import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeCodexToml,
  parseHostList,
  resolveMcpLaunch,
  pinLaunchDirectory,
  installHost,
  isHostConfigured,
  type McpLaunchSpec,
} from "../src/cli/install.js";

const tempHomes: string[] = [];

afterEach(() => {
  for (const dir of tempHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // restore HOME if we mutated it
  if ((globalThis as { __ocmemHome?: string }).__ocmemHome) {
    process.env.HOME = (globalThis as { __ocmemHome?: string }).__ocmemHome;
    delete (globalThis as { __ocmemHome?: string }).__ocmemHome;
  }
});

function withTempHome(): string {
  if (!(globalThis as { __ocmemHome?: string }).__ocmemHome) {
    (globalThis as { __ocmemHome?: string }).__ocmemHome = process.env.HOME;
  }
  const home = mkdtempSync(join(tmpdir(), "opencode-mem-install-home-"));
  tempHomes.push(home);
  process.env.HOME = home;
  return home;
}

const launch: McpLaunchSpec = {
  command: "npx",
  args: ["-y", "opencode-mem", "mcp"],
  env: { OPENCODE_MEM_PLATFORM: "mcp" },
};

describe("install helpers", () => {
  it("parses host lists", () => {
    expect(parseHostList("cursor")).toEqual(["cursor"]);
    expect(parseHostList("cursor,claude")).toEqual(["cursor", "claude"]);
    expect(parseHostList("all")).toContain("opencode");
    expect(() => parseHostList("nope")).toThrow(/Unknown host/);
    expect(() => parseHostList(undefined)).toThrow(/Missing --host \/ --ide/);
  });

  it("auto detects from a fake home", () => {
    const home = withTempHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    expect(parseHostList("auto")).toEqual(["cursor"]);
  });

  it("resolves a portable npx launch without pinning directory", () => {
    const original = process.argv[1];
    process.argv[1] = "opencode-mem";
    try {
      const spec = resolveMcpLaunch("/tmp/project", "cursor");
      expect(spec.command).toBe("npx");
      expect(spec.args).toEqual(["-y", "opencode-mem", "mcp"]);
      expect(spec.env?.OPENCODE_MEM_PLATFORM).toBe("cursor");
      expect(spec.env?.OPENCODE_MEM_DIRECTORY).toBeUndefined();
      expect(pinLaunchDirectory(spec, "/tmp/project").env?.OPENCODE_MEM_DIRECTORY).toBe(
        "/tmp/project"
      );
    } finally {
      process.argv[1] = original;
    }
  });
});

describe("mergeCodexToml", () => {
  it("appends and replaces the opencode-mem section idempotently", () => {
    const section = `[mcp_servers.opencode-mem]
command = "npx"
args = ["-y", "opencode-mem", "mcp"]
`;
    const created = mergeCodexToml("", section);
    expect(created).toContain("[mcp_servers.opencode-mem]");

    const withOther = mergeCodexToml('model = "gpt-5"\n', section);
    expect(withOther).toContain('model = "gpt-5"');
    expect(withOther).toContain("[mcp_servers.opencode-mem]");

    const updated = mergeCodexToml(
      withOther,
      `[mcp_servers.opencode-mem]
command = "node"
args = ["/cli.js", "mcp"]
`
    );
    expect(updated).toContain('command = "node"');
    expect(updated.match(/\[mcp_servers\.opencode-mem\]/g)?.length).toBe(1);
  });
});

describe("installHost writers", () => {
  it("creates and merges Cursor mcp.json", () => {
    const home = withTempHome();
    const first = installHost("cursor", { launch });
    expect(first.action).toBe("created");
    const path = join(home, ".cursor", "mcp.json");
    const json = JSON.parse(readFileSync(path, "utf-8"));
    expect(json.mcpServers["opencode-mem"].command).toBe("npx");
    expect(json.mcpServers["opencode-mem"].env.OPENCODE_MEM_DIRECTORY).toBeUndefined();

    // Preserve sibling servers on update
    writeFileSync(
      path,
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "echo" },
            "opencode-mem": json.mcpServers["opencode-mem"],
          },
        },
        null,
        2
      )
    );
    const second = installHost("cursor", {
      launch: {
        command: "node",
        args: ["/x/cli.js", "mcp"],
        env: { OPENCODE_MEM_PLATFORM: "cursor" },
      },
    });
    expect(second.action).toBe("updated");
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.mcpServers.other.command).toBe("echo");
    expect(after.mcpServers["opencode-mem"].command).toBe("node");
  });

  it("writes Claude, Gemini, Codex, OpenCode, and other supported hosts", () => {
    const home = withTempHome();
    expect(installHost("claude", { launch }).action).toBe("created");
    expect(installHost("gemini", { launch }).action).toBe("created");
    expect(installHost("codex", { launch }).action).toBe("created");
    expect(installHost("opencode", { projectDir: "/proj", launch }).action).toBe("created");
    expect(installHost("windsurf", { launch }).action).toBe("created");
    expect(installHost("kimi", { launch }).action).toBe("created");
    expect(installHost("openclaw", { launch }).action).toBe("created");
    expect(installHost("goose", { launch }).action).toBe("created");
    expect(installHost("warp", { launch }).action).toBe("created");
    expect(installHost("grok", { launch }).action).toBe("created");
    expect(installHost("antigravity", { launch }).action).toBe("created");
    expect(installHost("copilot", { launch }).action).toBe("created");

    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    expect(claude.mcpServers["opencode-mem"].args).toContain("mcp");

    const gemini = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf-8"));
    expect(gemini.mcpServers["opencode-mem"].command).toBe("npx");

    const codex = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    expect(codex).toContain("[mcp_servers.opencode-mem]");
    expect(codex).not.toContain("OPENCODE_MEM_DIRECTORY");

    const windsurf = JSON.parse(
      readFileSync(join(home, ".codeium", "windsurf", "mcp_config.json"), "utf-8")
    );
    expect(windsurf.mcpServers["opencode-mem"].command).toBe("npx");

    const kimiJson = JSON.parse(readFileSync(join(home, ".kimi-code", "mcp.json"), "utf-8"));
    expect(kimiJson.mcpServers["opencode-mem"].args).toContain("mcp");

    const goose = readFileSync(join(home, ".config", "goose", "config.yaml"), "utf-8");
    expect(goose).toContain("opencode-mem:");
    expect(goose).toContain("type: stdio");
    expect(goose).toContain("envs:");
    expect(goose).not.toMatch(/^\s+env:/m);

    const openclaw = JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf-8"));
    expect(openclaw.mcp.servers["opencode-mem"].command).toBe("npx");

    const warp = JSON.parse(readFileSync(join(home, ".warp", ".mcp.json"), "utf-8"));
    expect(warp.mcpServers["opencode-mem"].command).toBe("npx");

    const grok = readFileSync(join(home, ".grok", "config.toml"), "utf-8");
    expect(grok).toContain("[mcp_servers.opencode-mem]");

    const antigravity = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf-8")
    );
    expect(antigravity.mcpServers["opencode-mem"].command).toBe("npx");

    const copilotUser = JSON.parse(
      readFileSync(
        process.platform === "darwin"
          ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
          : join(home, ".config", "Code", "User", "mcp.json"),
        "utf-8"
      )
    );
    expect(copilotUser.servers["opencode-mem"].type).toBe("stdio");

    const opencode = JSON.parse(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf-8")
    );
    expect(opencode.plugins).toContain("opencode-mem@latest");
    expect(opencode.mcp["opencode-mem"].type).toBe("local");
    expect(opencode.mcp["opencode-mem"].command).toEqual(["npx", "-y", "opencode-mem", "mcp"]);
    expect(opencode.mcp["opencode-mem"].environment.OPENCODE_MEM_PLATFORM).toBe("opencode");
    expect(opencode.mcp["opencode-mem"].cwd).toBeUndefined();

    const again = installHost("opencode", { projectDir: "/proj", launch });
    expect(again.action).toBe("unchanged");

    expect(isHostConfigured("cursor")).toBe(false);
    installHost("cursor", { launch });
    expect(isHostConfigured("cursor")).toBe(true);
    expect(isHostConfigured("opencode")).toBe(true);
    expect(isHostConfigured("gemini")).toBe(true);
    expect(isHostConfigured("openclaw")).toBe(true);
    expect(isHostConfigured("warp")).toBe(true);
    expect(isHostConfigured("grok")).toBe(true);
    expect(isHostConfigured("antigravity")).toBe(true);
    expect(isHostConfigured("copilot")).toBe(true);
  });

  it("writes project-local MCP configs when projectDir is set", () => {
    const home = withTempHome();
    const project = join(home, "repo");
    mkdirSync(join(project, ".git"), { recursive: true });

    const cursor = installHost("cursor", { projectDir: project, launch });
    expect(cursor.also).toContain(join(project, ".cursor", "mcp.json"));
    expect(cursor.also).toContain(join(project, ".cursor", "rules", "opencode-mem.mdc"));
    const cursorProject = JSON.parse(readFileSync(join(project, ".cursor", "mcp.json"), "utf-8"));
    expect(cursorProject.mcpServers["opencode-mem"].env.OPENCODE_MEM_DIRECTORY).toBe(project);
    const cursorUser = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8"));
    expect(cursorUser.mcpServers["opencode-mem"].env.OPENCODE_MEM_DIRECTORY).toBeUndefined();
    const cursorRule = readFileSync(join(project, ".cursor", "rules", "opencode-mem.mdc"), "utf-8");
    expect(cursorRule).toContain("alwaysApply: true");
    expect(cursorRule).toContain("memory_timeline");

    const claude = installHost("claude", { projectDir: project, launch });
    expect(claude.also).toContain(join(project, ".mcp.json"));
    expect(claude.also).toContain(join(project, "CLAUDE.md"));
    const claudeMd = readFileSync(join(project, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("opencode-mem:begin");
    expect(claudeMd).toContain("memory_timeline");

    const windsurf = installHost("windsurf", { projectDir: project, launch });
    expect(windsurf.also).toContain(join(project, ".windsurf", "rules", "opencode-mem.md"));

    const copilot = installHost("copilot", { projectDir: project, launch });
    expect(copilot.also).toContain(join(project, ".vscode", "mcp.json"));
    const vscodeMcp = JSON.parse(readFileSync(join(project, ".vscode", "mcp.json"), "utf-8"));
    expect(vscodeMcp.servers["opencode-mem"].type).toBe("stdio");
    expect(vscodeMcp.servers["opencode-mem"].command).toBe("npx");

    const oc = installHost("opencode", { projectDir: project, launch });
    expect(oc.also).toContain(join(project, "opencode.json"));
    const projectOc = JSON.parse(readFileSync(join(project, "opencode.json"), "utf-8"));
    expect(projectOc.mcp["opencode-mem"].type).toBe("local");
    expect(projectOc.mcp["opencode-mem"].cwd).toBe(project);

    const antigravity = installHost("antigravity", { projectDir: project, launch });
    expect(antigravity.also).toContain(join(project, ".agents", "mcp_config.json"));

    const warp = installHost("warp", { projectDir: project, launch });
    expect(warp.also).toContain(join(project, ".warp", ".mcp.json"));

    const grok = installHost("grok", { projectDir: project, launch });
    expect(grok.also).toContain(join(project, ".grok", "config.toml"));
  });

  it("accepts common host aliases", () => {
    expect(parseHostList("claude-code,codex-cli,antigravity-cli,github-copilot")).toEqual([
      "claude",
      "codex",
      "antigravity",
      "copilot",
    ]);
  });

  it("merges into existing OpenCode plugins list", () => {
    const home = withTempHome();
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ plugins: ["something-else@1"] }, null, 2)
    );
    const result = installHost("opencode", { launch });
    expect(result.action).toBe("updated");
    const after = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8"));
    expect(after.plugins).toEqual(["something-else@1", "opencode-mem@latest"]);
    expect(after.mcp["opencode-mem"].enabled).toBe(true);
  });
});
