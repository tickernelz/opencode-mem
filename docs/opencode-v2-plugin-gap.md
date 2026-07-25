# OpenCode V2 Plugin API — Gap Analysis (#173)

Status: research spike on branch `research/opencode-v2-plugin-api`.  
opencode-mem remains **V1-only** for production loads. No dual-publish.

References:

- [Migrate from V1](https://v2.opencode.ai/migrate-v1)
- Local types: `@opencode-ai/plugin@1.18.5` → `@opencode-ai/plugin/v2/promise`

## Answers to issue #173

### 1. Timeline for full V2 plugin API support?

**No fixed release date.** Blockers:

| Capability opencode-mem needs                 | V2 promise API (`1.18.5`)                        |
| --------------------------------------------- | ------------------------------------------------ |
| Inject synthetic text into the user turn      | No `chat.message` (or equivalent) hook           |
| React to `session.idle` / `session.compacted` | No session event subscription on `PluginContext` |
| Register custom `memory` tool                 | No `tool` map on V2 `define({ setup })`          |
| Toast / TUI feedback                          | Not exposed on V2 context domains                |

Internal AI calls already use SDK-style `session.prompt` (`src/services/ai/opencode-provider.ts`, `src/services/user-profile/ai-cleanup.ts`). That is **not** the same as migrating the plugin registration surface.

Until OpenCode publishes stable V2 equivalents for message injection, session events, and custom tools, opencode-mem stays on the V1 entrypoint (`src/plugin.ts`).

### 2. Migration path for existing users?

| Asset                              | Compatible across OpenCode V1 → V2 host?                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| SQLite memory DBs / vector indexes | **Yes** — file-based, host-independent                                                                         |
| User profile data                  | **Yes**                                                                                                        |
| `opencode-mem.jsonc`               | **Yes** — plugin-owned config format unchanged                                                                 |
| OpenCode config entry              | **Needs edit** — V1 `plugin` array → V2 `plugins` objects ([migrate guide](https://v2.opencode.ai/migrate-v1)) |
| Nested install cache               | Clear `~/.cache/opencode/packages/opencode-mem@*` after a major plugin cut                                     |

No data migration tool is required for memories/profiles when the plugin itself gains a V2 entrypoint.

### 3. V2-native features under consideration (later)

Once the V2 surface is stable:

- **Agent-scoped memory** via `context.agent` transforms (per-agent tool/permission scopes)
- **Skill / command registration** for explicit memory workflows
- **Session-tree awareness** only after a durable session-event API exists

Not in scope for this spike.

## V1 surface inventory → V2 gap

| V1 hook / surface              | Location (after extract)      | Needed for                             | V2 status (`v2/promise`)                                       |
| ------------------------------ | ----------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `chat.message`                 | `src/hooks/chat-message.ts`   | Memory context injection + prompt save | **Missing**                                                    |
| `chat.params`                  | `src/hooks/chat-message.ts`   | Inherit model for prompt rows          | **Missing**                                                    |
| `tool.memory`                  | `src/hooks/memory-tool.ts`    | Agent memory tool                      | **Missing** (no tool registry on context)                      |
| `event` (`session.idle`)       | `src/hooks/session-events.ts` | Auto-capture + profile learning        | **Missing**                                                    |
| `event` (`session.compacted`)  | `src/hooks/session-events.ts` | Re-inject memories after compact       | **Missing**                                                    |
| Plugin module `{ id, server }` | `src/plugin.ts`               | OpenCode V1 loader                     | V2 wants `define({ id, setup })`                               |
| Host SDK `session.prompt`      | `src/services/ai/*`           | Structured output / cleanup            | **Partially present** (SDK client; separate from plugin hooks) |

V2 `PluginContext` domains today: `options`, `agent`, `aisdk`, `catalog`, `command`, `integration`, `plugin`, `reference`, `skill`.

## Spike artifacts on this branch

1. **Hook extraction** — V1 `src/index.ts` wires pure modules under `src/hooks/` (behavior unchanged).
2. **Inactive V2 stub** — `src/v2/plugin.ts` uses `define` from `@opencode-ai/plugin/v2/promise`. Not exported from `package.json`.
3. **Deps** — `@opencode-ai/plugin` / `@opencode-ai/sdk` pinned to `1.18.5` for V2 type access. onnxruntime / Intel-Mac packaging **untouched** (see fork branch `fix/intel-mac-onnxruntime-direct-dep` for #184).

## Live smoke (recorded on spike)

Run locally on 2026-07-25:

| Check                                                                              | Result                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `bun run typecheck` (includes `src/v2/plugin.ts`)                                  | pass                                                           |
| Runtime `import { define } from "@opencode-ai/plugin/v2/promise"` + stub `setup()` | pass (`id=opencode-mem`)                                       |
| V1 `dist/plugin.js` load → hooks `chat.message` / `chat.params` / `tool` / `event` | pass                                                           |
| `bun test` hooks + v2 stub + profile/tool-scope                                    | pass                                                           |
| OpenCode CLI host                                                                  | **1.18.5** (V1 plugin loader); no `opencode-v2` binary on PATH |
| Full OpenCode 2.0 beta host load of stub                                           | **not run** — requires separate V2 beta install                |
