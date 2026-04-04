# opencode-mem agent guide

## Overview

- Single-package Bun + TypeScript OpenCode plugin.
- Entry points: `src/plugin.ts` publishes `dist/plugin.js`; `src/index.ts` wires hooks, config init, warmup, and web server startup.

## Commands

- Install: `bun install`
- Build: `bun run build`
- Typecheck: `bun run typecheck`
- Format: `bun run format`
- Tests: `bun test`

## Global conventions

- Runtime is Bun, not Node. Use `bun:test`, `Bun.serve`, and `bun:sqlite` patterns already in the repo.
- Imports in source and tests use `.js` suffixes even when editing `.ts` files. Preserve that.
- `tsconfig.json` uses `verbatimModuleSyntax: true` and `noUncheckedIndexedAccess: true`; prefer `import type` for type-only imports and handle possible `undefined` values explicitly.
- `src/**/*` is the TypeScript program. Tests live in top-level `tests/` and are not part of the build include list.
- Reuse `src/config.ts` for configuration access. It merges global `~/.config/opencode/opencode-mem.jsonc` with project `.opencode/opencode-mem.jsonc` and resolves `file://` / `env://` secrets.
- Use `src/services/logger.ts` instead of ad hoc logging.

## Where to look

| Task                            | Location                                                     | Notes                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin lifecycle, hook wiring   | `src/index.ts`                                               | `OpenCodeMemPlugin` owns warmup, hook registration, and web server startup                                                                                   |
| Config keys and defaults        | `src/config.ts`                                              | Large template/config surface; do not duplicate parsing logic elsewhere                                                                                      |
| Memory CRUD facade              | `src/services/client.ts`                                     | Main service entry for add/search/list/delete                                                                                                                |
| HTTP/API surface                | `src/services/api-handlers.ts`, `src/services/web-server.ts` | Handlers define behavior; server maps routes and serves static files                                                                                         |
| AI providers and sessions       | `src/services/ai/`                                           | Read local `src/services/ai/AGENTS.md`                                                                                                                       |
| SQLite sharding and connections | `src/services/sqlite/`                                       | Read local `src/services/sqlite/AGENTS.md`                                                                                                                   |
| Browser UI                      | `src/web/`                                                   | Read local `src/web/AGENTS.md`                                                                                                                               |
| Docker runtime repro            | `docker/opencode-runtime-repro/`                             | Bare OpenCode container setup for isolating plugin runtime failures                                                                                          |
| Vector backend fallback         | `src/services/vector-backends/backend-factory.ts`            | `usearch` is optional; fallback to exact scan is intentional                                                                                                 |
| Chat injection helpers          | `src/services/chat-injection.ts`                             | `extractAssistantTail`, `buildSemanticQuery`, `mergeHybrid` for recent/semantic/hybrid selection modes                                                       |
| Debug logging helper            | `src/services/logger.ts`                                     | `logDebug(enabled, message, data?)` — gated helper; emits `[DEBUG]`-prefixed entries only when `enabled` is `true`; caller passes the flag; no config import |

## Project-specific gotchas

- Build output is `bunx tsc && mkdir -p dist/web && cp -r src/web/* dist/web/`. `src/web` is copied verbatim; no bundler or transpilation step exists for the UI.
- Runtime-only investigation patches may be applied directly to `dist/services/embedding.js` and `dist/index.js` to match OpenCode's plugin bootstrap behavior. Those changes are **volatile** and will be lost on rebuild unless the equivalent source fix is made in `src/`.
- When applying direct `dist/` patches for investigation, also copy the patched files into `patches/<timestamp>/` at repo root so the exact working runtime state survives rebuilds and can be diffed later.
- `src/services/vector-backends/backend-factory.ts` intentionally degrades from USearch to ExactScan when probe/search/rebuild fails. Do not replace that with hard failure unless behavior is intentionally changing.
- `src/services/migration-service.ts` is tightly coupled to the SQLite shard layout even though it lives outside `src/services/sqlite/`.
- First run can warm embeddings and external model dependencies; cold-start behavior is real.
- `chatMessage.maxAgeDays` is silently a no-op for `semantic` and `hybrid` selection modes because `SearchResult` (returned by vector search) carries no timestamp. Age filtering only applies to `recent` mode, which uses `listMemories` results that include `created_at`. A warning is logged at runtime when `maxAgeDays` is set with non-recent modes.
- `chatMessage.debug` is a temporary troubleshooting toggle (default `false`) that enables `[DEBUG]`-prefixed log entries for the injection pipeline. When writing new debug log call sites, use `logDebug(CONFIG.chatMessage.debug, ...)` and never log full memory text — only counts. Semantic query snippets must be truncated to at most 200 characters before passing to `logDebug`.

## Tests

- Test runner is Bun's built-in runner via `bun test`.
- Test files use `.test.ts` naming under `tests/` and still import local source with `.js` suffixes.
- Some tests create real temp directories, real SQLite files, and real git repos. Preserve cleanup patterns.

## Do not

- Do not convert `src/web` to TypeScript or add a bundler casually; the current copy-only build is deliberate.
- Do not bypass `config.ts` for new config loading.
- Do not replace Bun-specific APIs with Node equivalents without checking the whole runtime path.
