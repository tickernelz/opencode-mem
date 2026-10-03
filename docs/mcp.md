# Multi-host MCP setup

opencode-mem wires common coding-agent **hosts** (Cursor, Claude, Codex, …) via MCP + one shared local runtime.

Related: [Issue #366](https://github.com/tickernelz/opencode-mem/issues/366).

> Naming: **host** = Cursor / Claude / … (this doc). OpenCode **session agents** (build, orchestrator, …) and the internal structured-output agent are separate concepts.

## Quick start

```bash
# Detect every installed host and write MCP (or OpenCode plugin) configs
npx -y opencode-mem install --host auto --cwd "$PWD"

# Or install every supported harness
npx -y opencode-mem install --host all --cwd "$PWD"

# One shared runtime for all hosts
npx -y opencode-mem serve --cwd "$PWD"
npx -y opencode-mem status
```

Restart IDEs after install. `status` shows detected vs configured hosts. OpenCode attaches to a healthy `serve` when `preferSharedRuntime` is on (default).

With `--cwd`, install also writes **project-local** MCP configs (and pins `OPENCODE_MEM_DIRECTORY` there only). User-global configs stay multi-project safe (no baked directory).

## Supported hosts

| Host / `--host` (or `--ide`) | Config written                                                                            | `OPENCODE_MEM_PLATFORM` |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| `cursor`                     | `~/.cursor/mcp.json` (+ project `.cursor/mcp.json`)                                       | `cursor`                |
| `claude`                     | `~/.claude.json` (+ project `.mcp.json`)                                                  | `claude`                |
| `codex`                      | `~/.codex/config.toml` (+ project `.codex/config.toml`)                                   | `codex`                 |
| `gemini`                     | `~/.gemini/settings.json` (+ project `.gemini/settings.json`)                             | `gemini`                |
| `antigravity`                | `~/.gemini/config/mcp_config.json` (+ project `.agents/mcp_config.json`)                  | `antigravity`           |
| `opencode`                   | `~/.config/opencode/opencode.json` **plugin + MCP** (+ project `opencode.json`)           | `opencode`              |
| `windsurf`                   | `~/.codeium/windsurf/mcp_config.json`                                                     | `windsurf`              |
| `kimi`                       | `~/.kimi-code/mcp.json` (+ project `.kimi-code/mcp.json`)                                 | `kimi`                  |
| `openclaw`                   | `~/.openclaw/openclaw.json` → `mcp.servers`                                               | `openclaw`              |
| `goose`                      | `~/.config/goose/config.yaml` extension (`envs:`)                                         | `goose`                 |
| `warp`                       | `~/.warp/.mcp.json` (+ project `.warp/.mcp.json`)                                         | `warp`                  |
| `copilot`                    | VS Code User `mcp.json` (`servers`) + `~/.copilot/mcp-config.json` (+ `.vscode/mcp.json`) | `copilot`               |
| `grok`                       | `~/.grok/config.toml` (+ project `.grok/config.toml`)                                     | `grok`                  |
| `all`                        | every row above                                                                           | per-ide                 |
| `auto`                       | only detected installs                                                                    | per-ide                 |

Aliases: `claude-code`→`claude`, `codex-cli`→`codex`, `antigravity-cli`→`antigravity`, `github-copilot`→`copilot`.

## Architecture

```text
Cursor / Claude / Codex / Gemini / Windsurf / Kimi / …
  → MCP stdio (`opencode-mem mcp`)
    → shared serve (HTTP)
      → Turso + embeddings + Web UI

OpenCode plugin + MCP
  → preferSharedRuntime? attach to serve : in-process
  → MCP tools: memory_timeline / memory_search / memory_get / memory_write
```

### Shared-process boundary (`src/runtime/`)

`runtime/` owns the shared-process boundary — not domain storage:

| Piece                            | Role                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `runtime/client.ts`              | Discovery, auto-start `serve`, HTTP client               |
| `runtime/bridge.ts`              | OpenCode in-process attach pointer                       |
| `runtime/http/mcp-routes.ts`     | `/api/mcp/*` — **compact** progressive MCP shapes        |
| `runtime/http/runtime-routes.ts` | `/api/runtime/tool` — **full** plugin memory-tool shapes |

MCP hosts use `/api/mcp/*`. OpenCode attach uses `/api/runtime/tool` so search/list match in-process responses (full `content` / `similarity`, not snippets).

### Source layout

Thematic top-level modules (no `services/` catch-all):

```text
src/
  shared/           hosts + platform-source + api schemas
  cli/              serve / mcp / install / status
  mcp/              stdio only
  runtime/          client, bridge, http/ (MCP + REST/Web)
  hosts/opencode/   OpenCode plugin orchestration
  memory/           CRUD, capture, learning, tags, embedding, tool/, user-prompt/
  storage/          turso/ + shard/migration services
  ai/               providers, sessions, OpenCode AI helpers
  user-profile/     profile manager + learning lock
  infra/            logger, privacy, jsonc, onnx, secrets, …
  config.ts         root config
  plugin.ts         package plugin entry (V1+V2)
  index.ts          re-exports hosts/opencode helpers
  v2/               OpenCode v2 adapter
  types/            shared domain types
  utils/            small pure helpers
```

Guardrails:

1. Import shared-process APIs from `runtime/client.js` and `runtime/bridge.js` only.
2. New HTTP endpoints for MCP / shared runtime go under `runtime/http/`.
3. Host detection, MCP config writers, and host platform labels live in `shared/hosts.ts` + `cli/install/` — never under `storage/` / `ai/` / `memory/` storage internals.
4. Priming and config formats stay under `cli/install/`.

### Progressive tools (token-aware)

| Tool              | Role                                                       |
| ----------------- | ---------------------------------------------------------- |
| `memory_timeline` | Recent memories chronologically (session-start continuity) |
| `memory_search`   | Compact topical index (+ `platformSource`)                 |
| `memory_get`      | Full content for selected ids                              |
| `memory_write`    | add / forget / profile                                     |

Workflow: `memory_timeline` or `memory_search` → pick ids → `memory_get` (batch).

### Session priming (project `--cwd`)

For hosts without OpenCode-depth hooks, `install --cwd` also writes lightweight priming so the agent knows to call MCP at session start:

| Host                 | Priming file                                     |
| -------------------- | ------------------------------------------------ |
| Cursor               | `.cursor/rules/opencode-mem.mdc` (`alwaysApply`) |
| Claude               | `CLAUDE.md` marked block                         |
| Windsurf             | `.windsurf/rules/opencode-mem.md`                |
| Gemini / Antigravity | `GEMINI.md` marked block                         |
| Kimi                 | `.kimi-code/rules/opencode-mem.md`               |

OpenCode keeps native auto-capture / compaction inject — no priming file needed.

## Commands

```bash
opencode-mem serve [--host HOST] [--port PORT] [--cwd DIR]
opencode-mem mcp [--cwd DIR]
opencode-mem install --host <host[,host]|all|auto> [--cwd DIR]
opencode-mem status [--cwd DIR]
```

`--ide` remains a compatibility alias for install's `--host`.

## Env overrides

| Env                                  | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `OPENCODE_MEM_DIRECTORY`             | Project root for shards (project configs only) |
| `OPENCODE_MEM_PLATFORM`              | Provenance stamp (set per IDE by `install`)    |
| `OPENCODE_MEM_STORAGE_PATH`          | Override data directory                        |
| `OPENCODE_MEM_PREFER_SHARED_RUNTIME` | OpenCode attach vs in-process                  |

## Single-owner playbook

1. `opencode-mem serve --cwd "$PWD"`
2. `opencode-mem install --host auto --cwd "$PWD"`
3. Open OpenCode → attaches to serve; other hosts via MCP → same serve
4. `opencode-mem status` → one healthy URL + host coverage

## Adding a host

New coding-agent hosts go through the existing install catalog — **not** through Turso, AI, or web-server special cases.

1. Add a `HostSpec` entry in [`src/shared/hosts.ts`](../src/shared/hosts.ts) (`HOST_IDS`, detect/config paths, optional priming, `configKind`).
2. Wire install under [`src/cli/install/`](../src/cli/install/):
   - reuse a format in `formats/` when possible (`json`, `toml`, …), or add a small adapter under `hosts/` for one-off layouts;
   - `installHost()` already dispatches on `spec.configKind`.
3. Optional project priming via `priming` on the host spec + `install/priming.ts`.
4. Cover detection/config in `tests/install-ide.test.ts` (and status coverage if needed).

Do **not** put host detection, MCP config writers, or `platformSource` labels under `storage/`, `ai/`, or low-level memory persistence modules.

## Follow-ups (optional)

Still deferred (not required for the thematic layout):

1. Drop leftover `--ide` / `InstallIde` aliases once callers use `--host` / `HostId`.
2. Split oversized files (`runtime/http/api-handlers.ts`, `user-profile/user-profile-manager.ts`, `config.ts`).

Do **not** big-bang rename `storage/turso/`, `memory/tool/`, or `cli/install/` — those boundaries already work.

## Notes

- This is **MCP-first** multi-host wiring (faster + cheaper to maintain than native hooks per host).
- Progressive recall mirrors claude-mem-style disclosure (`timeline`/`search` → `get`); capture outside OpenCode stays host-initiated (`memory_write`) plus project priming rules.
- OpenCode keeps deep auto-capture / compaction / profile learning; when attached, capture **writes** go through the shared runtime.
- Auth: `~/.opencode-mem/.auth-token`. Runtime pointer: `~/.opencode-mem/runtime.json`.
