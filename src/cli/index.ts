#!/usr/bin/env node
import { runServe } from "./serve.js";
import { runMcpServer } from "../mcp/server.js";
import { parseHostList, runInstall, SUPPORTED_HOSTS, HOST_NEXT_STEPS } from "./install.js";
import { printStatus } from "./status.js";

function printHelp(): void {
  console.log(`opencode-mem — local memory runtime for coding-agent hosts

Usage:
  opencode-mem serve [--host HOST] [--port PORT] [--cwd DIR]
  opencode-mem mcp [--cwd DIR]
  opencode-mem install --host <host[,host]|all|auto> [--cwd DIR]
  opencode-mem status [--cwd DIR]
  opencode-mem help

Commands:
  serve     Start the standalone HTTP + Web UI runtime (Turso + embeddings owner)
  mcp       Start the MCP stdio server (proxies to serve; auto-starts serve if needed)
  install   Write MCP (or OpenCode plugin) config for coding-agent hosts
  status    Show whether a shared runtime is healthy

Install hosts:
  ${SUPPORTED_HOSTS.join(", ")}, all, auto

  Flags: --host (preferred) or --ide (alias)

Examples:
  opencode-mem install --host auto --cwd "$PWD"
  opencode-mem install --host cursor --cwd /path/to/project
  opencode-mem install --ide cursor,claude,codex
  opencode-mem install --host all
  opencode-mem serve --cwd "$PWD"
  npx -y opencode-mem mcp
`);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const rest = argv.slice(1);
  const cwd = readFlag(rest, "--cwd") ?? process.env.OPENCODE_MEM_DIRECTORY ?? process.cwd();

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve") {
    const host = readFlag(rest, "--host");
    const portRaw = readFlag(rest, "--port");
    const port = portRaw ? Number(portRaw) : undefined;
    if (portRaw && (!Number.isFinite(port) || (port as number) <= 0)) {
      console.error(`Invalid --port: ${portRaw}`);
      process.exit(1);
    }
    await runServe({ directory: cwd, host, port });
    // Keep the process alive while the HTTP server runs.
    await new Promise(() => {});
    return;
  }

  if (command === "mcp") {
    await runMcpServer(cwd);
    return;
  }

  if (command === "install") {
    if (hasFlag(rest, "--help") || hasFlag(rest, "-h")) {
      printHelp();
      return;
    }
    // --host is preferred; --ide remains as a compatibility alias.
    const hostRaw = readFlag(rest, "--host") ?? readFlag(rest, "--ide");
    const hosts = parseHostList(hostRaw);
    const results = runInstall({ hosts, projectDir: cwd });
    for (const result of results) {
      console.log(`[${result.action}] ${result.host}: ${result.path}\n  ${result.detail}`);
      if (result.also?.length) {
        for (const extra of result.also) {
          console.log(`  + ${extra}`);
        }
      }
    }
    console.log("\nNext steps:");
    const seen = new Set<string>();
    for (const result of results) {
      const tip = HOST_NEXT_STEPS[result.host];
      if (tip && !seen.has(result.host)) {
        seen.add(result.host);
        console.log(`  - ${result.host}: ${tip}`);
      }
    }
    console.log("  - Prefer one shared runtime: opencode-mem serve");
    console.log("  - Verify: opencode-mem status");
    return;
  }

  if (command === "status") {
    await printStatus(cwd);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
