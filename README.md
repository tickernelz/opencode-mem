# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)

![OpenCode Memory Banner](.github/pics/banner.png)

A persistent memory system for AI coding agents that enables long-term context retention across sessions using local vector database technology.

## Core Features

Local Turso/libSQL database with native vector search, persistent project memories, automatic user profile learning, unified memory-prompt timeline, full-featured web UI, intelligent prompt-based memory extraction, multi-provider AI support (OpenAI, Anthropic), 12+ local embedding models, smart deduplication, and built-in privacy protection.

## Prerequisites

This plugin uses embedded Turso (`@tursodatabase/database`) with `F32_BLOB` vectors and exact cosine search via `vector_distance_cos`. No separate vector database or custom SQLite build is required.

**Recommended runtime:**

- Bun
- Standard OpenCode plugin environment
- Internet access on first use if you use the default local embedding model, because the model is downloaded by `@huggingface/transformers`.
- For source/development installs, run `bun install` before building or testing. The published plugin package installs its runtime dependencies automatically through OpenCode.

**CI-tested platforms:** Linux, Windows, and macOS 15 / macOS 26 on Apple Silicon (`darwin/arm64`). **Intel Mac (`darwin/x64`) is not supported** — `@tursodatabase/database` and fixed `onnxruntime-node` releases ship no x64 native binding. Older macOS releases are not excluded by that matrix; they are simply outside the current GitHub-hosted runner set.

**Notes:**

- Vector embeddings are stored and searched directly in Turso; inserts store `F32_BLOB` vectors for exact cosine ranking.
- Vector search uses exact cosine distance via `vector_distance_cos` (no DiskANN / approximate index).
- Auto-capture and user profile learning require an AI provider that can return structured/tool-call output. Memory search/add/list still work without auto-capture provider configuration.

### Hardware / resource expectations

opencode-mem does **not** require a GPU. Local embeddings run on CPU via `@huggingface/transformers` and ONNX (there is no MLX backend). Extra VRAM is not needed.

| Workload                                                      | Typical extra resources                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local embeddings** (default `Xenova/nomic-embed-text-v1`)   | About **0.5–2 GB RAM** while the model is loaded, depending on the Hugging Face id you pick. First use downloads the model; disk cache lives under `{storagePath}/.cache` (default `~/.opencode-mem/data/.cache`) and is often **hundreds of MB to ~1–2 GB** per model. |
| **Remote embeddings** (`embeddingApiUrl` + `embeddingApiKey`) | Negligible local ML RAM — only plugin + Turso overhead.                                                                                                                                                                                                                 |
| **Database / plugin**                                         | Turso/libSQL on disk under `storagePath`. Size grows with how many memories you store, not with GPU memory.                                                                                                                                                             |

Platform limits above still apply (no Intel Mac `darwin/x64`; use Apple Silicon, Linux, Windows, or a remote embedding endpoint). See [Choosing / configuring embeddings](#choosing--configuring-embeddings).

### Upgrading from legacy SQLite shards

Startup recovers interrupted re-embed swaps, converts libSQL DiskANN indexes to the current Turso engine, and then verifies or upgrades the legacy shard schema. Engine conversion runs even when a store already has a completed legacy migration marker, and preserves stored vectors without re-embedding. Each converted database is backed up as `<database>.pre-tursodb-<timestamp>.bak`.

On macOS and Linux, multiple OpenCode sessions can share the same `storagePath` via Turso’s experimental `multiprocess_wal` (every process must use the same mode — restart all sessions after upgrading). On Windows the engine rejects that flag, so only one OpenCode session can own the memory databases at a time.

On first startup after upgrading, opencode-mem automatically migrates existing memory shard databases to native Turso/libSQL vector format:

- Each shard is backed up as `<shard>.db.legacy.bak` before rewrite
- Progress is tracked per shard in `<shard>.db.turso-migrate.json`
- A global marker `.turso-migrated` is written only after all shards verify successfully
- Do not run multiple OpenCode instances against the same `storagePath` during migration; a lock file (`.turso-migrate.lock`) prevents concurrent migration
- Manual dimension migrations use `.turso-operation.lock`; other plugin processes reject new memory writes until the migration finishes

If migration is interrupted, the next startup resumes from the backup automatically.

If a shard becomes incompatible (for example after changing `embeddingDimensions`), writes are blocked and the original database is left untouched. Use the Web UI's re-embed migration to build and verify a replacement before it is swapped into place. The previous shard remains available as `<shard>.db.pre-reembed-<pid>-<timestamp>.bak`.

## Schema migrations

Local Turso shards and auxiliary databases (`metadata.db`, `user-prompts.db`, `user-profiles.db`, `ai-sessions.db`) are upgraded with ordered `PRAGMA user_version` migrations in `src/services/turso/schema-migrations.ts`. Migrations are idempotent: starting the plugin applies only pending versions.

## Getting Started

For OpenCode v2, add the package to the native `plugins` list:

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

For OpenCode v1, add the default entrypoint to your configuration at
`~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

With `@latest` (or a semver range) and `autoUpdate: true` in `opencode-mem.jsonc` (default), the plugin clears OpenCode's cached install when a newer npm release is available and asks you to restart. Pinned versions like `opencode-mem@2.26.0` are never auto-updated.

### Automatic memory context on OpenCode v2

The v2 plugin supplies automatic memory context through the model's system context.
These blocks are not added to the authored user prompt or stored in the chat transcript.
With `chatMessage.injectOn: "first"` (the default), the session's initial context is
retained across user turns and model steps. With `"always"`, it is refreshed on each
authored user turn.

After a host or plugin restart, a resumed session rebuilds its context from the
current memory store on its next model request, even if no new user prompt arrives.
The rebuilt context may differ from the original as memories and the profile evolve.
Restoration does not capture a synthetic user prompt or store a second copy of the
memory text in OpenCode plugin storage. Compaction invalidates the cached automatic
context; the existing compaction-memory restoration also continues to run.

### Using a local checkout

To run the plugin from a local source checkout instead of the npm release, `bun install && bun run build` in the checkout, then point the `plugins` list at the checkout directory:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

Point at the package root, not at `dist/` or a single file. OpenCode resolves a directory plugin by falling back to `<directory>/index` (OpenCode does not read `package.json` `exports`/`main` for a path spec on current releases), so this repository ships a thin root `index.js` that re-exports the built v2 entrypoint from `dist/plugin.js`. A path to a file is rejected (`configured plugin path must be a directory`), and a directory without a root `index.js` is skipped silently.

### Optional database encryption at rest

Enable AES-256-GCM encryption for local Turso shards in `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "databaseEncryptionEnabled": true,
}
```

On first start the plugin creates `~/.config/opencode/opencode-mem-db.key` (32-byte hex key, `chmod 600`) and migrates existing plaintext shards. Override with `"databaseEncryptionKey": "env://OPENCODE_MEM_DB_KEY"` or `"file://~/path/to.key"` if you manage the key yourself. Losing the key means the encrypted databases cannot be opened.

**Windows:** use `%USERPROFILE%\.config\opencode\opencode.json` (for example `C:\Users\<you>\.config\opencode\opencode.json`). This plugin does **not** read `%APPDATA%` or `%LOCALAPPDATA%` for its OpenCode plugin entry — put the file under `.config\opencode` in your user profile, then restart OpenCode. If the plugin does not appear, confirm that path and restart again.

The plugin downloads automatically on next startup.

## How to use day-to-day

You do **not** need to ask OpenCode to “remember” things for the plugin to work. With the defaults, memory builds up as you work.

### Typical daily flow

1. Enable the plugin (see [Getting Started](#getting-started)) and restart OpenCode.
2. Configure an AI provider for auto-capture — recommended: `opencodeProvider` + `opencodeModel` (or `"opencodeModel": "inherit"`). Details under [Auto-Capture AI Provider](#auto-capture-ai-provider).
3. Work normally in OpenCode. When a session goes idle, auto-capture extracts memorable technical context and stores it.
4. In later sessions, relevant memories are injected into context (see `chatMessage` / compaction settings). Browse or edit them in the web UI at `http://127.0.0.1:4747`.
5. Use the `memory` tool when you want something stored or retrieved immediately (see [Usage Examples](#usage-examples)).

### Automatic vs manual memory

| Approach                                               | When it runs                                        | What you do                                                                                |
| ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Auto-capture** (`autoCaptureEnabled: true`, default) | After conversation turns when the session goes idle | Nothing — extraction is automatic                                                          |
| **Manual** `memory` tool / commands                    | On demand                                           | `add`, `search`, `list`, `profile`, `forget`, `list-shards`, `migrate`, `export`, `import` |

Manual search/add/list still work even if auto-capture has no provider configured. Auto-capture and user profile learning need a provider that can return structured/tool-call output.

### Memory vs AGENTS.md / project docs

| Store in **memory**                                                  | Store in **AGENTS.md** / static docs                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Project-specific decisions, bug patterns, “we tried X and it failed” | Stable rules and workflows that rarely change               |
| User preferences discovered over sessions                            | Always-on coding conventions and process                    |
| Facts that should follow you across chats                            | Instructions every agent should see regardless of retrieval |

Rule of thumb: if it is a lasting project instruction, put it in AGENTS.md; if it is context that grows from real work, let memory (or auto-capture) hold it.

### Intelligent prompt-based memory extraction

That phrase in the feature list is **auto-capture**: after a conversation, a background AI request summarizes technical work and saves it as memory. No special prompt from you is required. It uses `opencodeProvider` / `opencodeModel` when set, otherwise the manual `memoryProvider` fallback.

### User profile

The **User Profile** is a separate, cross-project summary of how you like to work (preferences, habits). It is updated on an interval (`userProfileAnalysisInterval`, default every 10 analyzed prompts), shown in the web UI’s profile view, and readable via `memory({ mode: "profile" })`. You do not populate it by hand for normal use — profile learning fills it when a provider is ready. Output language follows `autoCaptureLanguage` (default `"auto"`, mirroring the language of your prompts), the same setting used for auto-captured memories.

**“No profile found. Keep chatting to build your profile.”** is the expected empty state, not a crash. Profile learning needs:

1. Auto-capture running with a reachable provider (`opencodeProvider` + `opencodeModel`, or a complete manual fallback with `memoryModel` + `memoryApiUrl`).
2. Enough session prompts since the last analysis — at least `userProfileAnalysisInterval` (default **10**).
3. That provider to support structured/tool-call output (same requirement as auto-capture).

If you have chatted for a while and still see the message, check that auto-capture is actually firing in the logs and that the configured provider succeeds (failed profile analysis no longer hides behind a generic empty state when the provider errors).

### Web UI

Open `http://127.0.0.1:4747` to browse the memory–prompt timeline, inspect captures, and manage the user profile. If you bind the server beyond loopback, see [Web UI HTTP Basic Auth](#web-ui-http-basic-auth).

## Usage Examples

```typescript
memory({ mode: "add", content: "Project uses microservices architecture" });
memory({ mode: "search", query: "architecture decisions" });
memory({ mode: "search", query: "architecture decisions", scope: "all-projects" });
memory({ mode: "profile" });
memory({ mode: "list", limit: 10 });
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
memory({ mode: "export", outputPath: "./memories.json" });
memory({ mode: "import", inputPath: "./memories.json" });
```

Access the web interface at `http://127.0.0.1:4747` for visual memory browsing and management.

**Network binding security:** Keep `webServerHost` on `127.0.0.1` unless you intentionally expose the UI. Binding to `0.0.0.0` (or any non-loopback host) requires `webServerApiToken`; all `/api/*` requests must then send `Authorization: Bearer <token>` or `X-Opencode-Mem-Token`. Open the UI with `?apiToken=<token>` so the browser stores and sends it.

Dimension migrations generate every new embedding first, import them into a temporary indexed shard, verify the row count, and only then replace the original file. Failed migrations leave the source shard untouched.

## Configuration Essentials

Configure at `~/.config/opencode/opencode-mem.jsonc`:

**Windows:** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc` (same `.config\opencode` directory as above — not AppData). Default storage resolves to `%USERPROFILE%\.opencode-mem\data` (the `~` form expands to your user home on Windows as well).

The plugin creates a full commented template at this path on first startup. For every setting and comment, see [`opencode-mem.example.jsonc`](opencode-mem.example.jsonc).

### Choosing / configuring embeddings

Embeddings power similarity search for memories and the user profile. Configure them in the same file (`~/.config/opencode/opencode-mem.jsonc`). There is **no MLX backend** — local embeddings use `@huggingface/transformers` with ONNX, not Apple MLX.

**Local (default):** set only `embeddingModel`. On first use the model is downloaded from Hugging Face and cached under `{storagePath}/.cache` (default `~/.opencode-mem/data/.cache`).

**Remote (OpenAI-compatible):** set both `embeddingApiUrl` and `embeddingApiKey`. The plugin then calls `{embeddingApiUrl}/embeddings` with a Bearer token. `embeddingApiKey` accepts the same secret formats as `memoryApiKey` (`literal`, `env://…`, `file://…`).

| Key                   | Role                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `embeddingModel`      | Hugging Face id (local) or API model name (remote). Default: `Xenova/nomic-embed-text-v1` |
| `embeddingDimensions` | Optional override; usually omit — dimensions are looked up from a built-in map            |
| `embeddingApiUrl`     | Base URL for an OpenAI-compatible embeddings API (no trailing path beyond `/v1`)          |
| `embeddingApiKey`     | API key for that endpoint (required together with `embeddingApiUrl`)                      |

Recommended local models:

| Model                                | Dims | Notes                               |
| ------------------------------------ | ---- | ----------------------------------- |
| `Xenova/nomic-embed-text-v1`         | 768  | Default; multilingual, 8192 context |
| `Xenova/jina-embeddings-v2-base-en`  | 768  | English-only, 8192 context          |
| `Xenova/jina-embeddings-v2-small-en` | 512  | Faster, 8192 context                |
| `Xenova/all-MiniLM-L6-v2`            | 384  | Very fast, 512 context              |
| `Xenova/all-mpnet-base-v2`           | 768  | Good quality, 512 context           |

Example — remote OpenAI embeddings:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

Changing `embeddingModel` (or dimensions) can trigger re-embedding of stored memories on next startup. Prefer picking a model once and sticking with it for a given data directory.

**Unsupported — Intel Mac (`darwin/x64`):** Local persistence requires `@tursodatabase/database`, which does not publish an Intel Mac native binding. Fixed `onnxruntime-node` releases (`1.24.1+`, including the pinned `1.30.0`) also lack darwin/x64. Use an Apple Silicon Mac, Linux, or Windows, or a remote endpoint via `embeddingApiUrl` + `embeddingApiKey` (example above). On supported platforms, `opencode-mem` pins `onnxruntime-node@1.30.0` (Ort::Env teardown fix from `1.24.1` / #225) and loads transformers through a CJS resolve shim so OpenCode nested installs keep that binding. Transformers is resolved to an absolute path before that shim is installed so OpenCode's Bun `--compile` host does not fail with `Cannot find module '@huggingface/transformers' from ''`. After upgrading, clear OpenCode's nested plugin cache (`~/.cache/opencode/packages/opencode-mem@*`) and reinstall.

### Memory Scope

- `scope: "project"`: query only the current project. This is the default.
- `scope: "all-projects"`: query `search` / `list` across all project shards.
- `memory.defaultScope` sets the default query scope when no explicit scope is provided.

### Web UI HTTP Basic Auth

When `webServerHost` is set to anything other than loopback (for example `0.0.0.0`), the web UI is reachable by anyone on the network. To keep your memories off the LAN, gate the web server with HTTP Basic Auth via the same config file used for everything else:

```jsonc
{
  "webServerHost": "0.0.0.0", // optional: reach the UI from the LAN
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optional, defaults to the current OS user
}
```

| Field                   | Default           | Effect                                                                                                                       |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `webServerAuthPassword` | _(empty)_         | When set, the server demands HTTP Basic Auth credentials on every request. Leave empty to keep the open-by-default behavior. |
| `webServerAuthUsername` | OS user (`$USER`) | Username required by the Basic Auth challenge.                                                                               |

`webServerAuthPassword` accepts the same secret formats as `memoryApiKey`:

- a literal string (simple, fine for personal machines),
- `env://SOME_ENV_VAR` to pull the value from the environment at startup,
- `file:///path/to/secret` to read it from a file (`chmod 600` recommended — the plugin will warn if the file is world-readable).

The browser will pop its native Basic Auth dialog and remember the credentials for the current session; closing all browser windows discards them, so reopening the browser requires signing in again. Credentials are compared with a constant-time check, and the unauthenticated 401 response carries `Cache-Control: no-store` so no intermediate cache will replay it. CORS is also relaxed once auth is on, so other tools on the same LAN can talk to the API after authenticating.

### Sharing One Project Memory Across Nested Repos

By default a project is identified by its enclosing git repository, so every
physical git repo gets its own isolated memory store. That is wrong for
multi-repo workspaces — trees managed by Google [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md),
monorepos, or any layout where several nested git repositories belong to one
logical project — because each sub-repository would be siloed.

Drop an empty **`.opencode-mem-project`** marker file at the workspace root:

```
my-workspace/
├── .opencode-mem-project   ← workspace root
├── kernel/                 (own git repo)
├── userspace/              (own git repo)
└── tools/                  (own git repo)
```

Every session started anywhere underneath the marker then resolves onto that
root and shares one memory store, regardless of which sub-repo the working
directory lives in:

```sh
touch ~/my-workspace/.opencode-mem-project
```

The marker is looked up by walking up from the working directory that every
code path already passes in (the plugin's working directory, the web API's
`process.cwd()`), so identity is **directory-driven and process-independent**.
It does not rely on environment variables or a global config value, which
would be unreliable here: opencode-mem runs across multiple opencode processes
that share a single web server, and only some of those processes carry a
given env var. With the marker, the project root is always derived from where
the session actually runs.

The marker takes precedence over git detection. When it is present, the
sub-repo's own git remote is intentionally ignored (it would describe only one
nested repository). Without a marker, behavior is unchanged (git-based
identity).

### Moving or Recovering Project Memories

opencode-mem keys project shards by a hash of the project identity. Moving a
repository (OS migration, path reorganization, switching from a Windows mount
to a native path) can therefore orphan the old shard under
`~/.opencode-mem/data/projects/` while a new empty shard is created for the
new path.

These are OpenCode `memory` tool calls with JSON arguments, not commands to
run in a terminal. The issue-style `memory migrate --from ...` notation maps
to `memory({ mode: "migrate", fromPath: "..." })`.

**1. Local move when you still know the old path**

Open OpenCode in the **new** project directory. The target project must not
already contain memories (migration aborts unchanged on conflict). Preview the
detected source, destination, and file actions before changing anything:

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

For safety, migration refuses a source whose stored project directory still
exists. If you intentionally want to move an active source, inspect the dry-run
output first and then pass `allowLinkedSource: true`. Original source shard
files are retained as timestamped `*.pre-path-migrate-*.bak` backups.

**2. Old path is gone — discover the orphaned shard first**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` reports each project hash, stored `projectPath`, memory count,
and status (`current`, `linked`, `orphaned`, `missing-file`, `empty`, or
`ambiguous`). `fromHash` is the 16-character lowercase hexadecimal `scopeHash`
returned by this call. Prefer it when the old directory no longer exists or
multiple shards contain the same stored path, because git-based identities
cannot always be recomputed from a missing path.

**3. Cross-machine backup / restore**

```typescript
// on the source machine / old checkout
memory({ mode: "export", outputPath: "./memories.json" });

// on the destination machine / new checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

Export writes a versioned JSON document without vectors. Import remaps the
memories onto the current project and recomputes embeddings with the currently
configured model. Import adds memories to an existing project, but duplicate
memory IDs abort the whole import before writing; this differs from `migrate`,
which requires an empty target.

Export files are plaintext and can contain memory content, user names/email
addresses, repository URLs, and absolute project paths. Store them like other
sensitive backups and delete them when no longer needed. Fully private entries
are omitted, and user profiles and prompt history are not included. The
document contains `schemaVersion: 1`; imports reject newer unsupported schema
versions rather than guessing.

### Auto-Capture AI Provider

Auto-capture runs a background AI request to summarize technical work and save it as memory. It needs one of the provider configurations below.

**Recommended:** Use a provider that is already authenticated in opencode and supports structured output:

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

The plugin issues structured-output requests to opencode's session API instead of calling provider endpoints directly, so opencode owns the auth, token refresh, and provider routing. The provider name must match an entry from `opencode providers list`, and the selected model must support structured JSON output through opencode.

Supported providers: any provider listed by `opencode providers list` (e.g. `anthropic`, `openai`, `github-copilot`, ...).

If `opencodeProvider` and `opencodeModel` are set, they take precedence over the manual `memoryProvider` settings below.

**Follow the session model:** set `"opencodeModel": "inherit"` to use a concrete OpenCode model at call time instead of a pinned id. For **auto-capture**, each prompt is recorded via the `chat.params` hook and the capture request reuses that prompt's provider/model. For **profile learning** and other structured-output paths (which are not tied to a single user message), `inherit` falls back to the most recent model in OpenCode's `model.json` recent list (preferring the configured `opencodeProvider`). Sending the literal model id `inherit` is never valid and previously caused `ProviderModelNotFoundError: Model not found: <provider>/inherit` on those paths. `opencodeProvider` is still required as the normal config gate.

**Fallback:** Manual API configuration (if not using opencodeProvider):

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API Key Formats:**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Manual `memoryProvider` modes:

- `openai-chat`: OpenAI Chat Completions compatible API with tool/function calling. This can work with compatible proxies such as LiteLLM only when the selected upstream model and proxy preserve tool calls.
- `openai-responses`: OpenAI Responses API with function-call output.
- `anthropic`: Anthropic Messages API with tool use.
- `minimax`: MiniMax Anthropic Messages-compatible endpoint. Set `memoryApiUrl` to the global endpoint (`https://api.minimax.io`) or the China endpoint (`https://api.minimaxi.com`); the `/anthropic/v1/messages` path and `x-api-key` header are applied automatically. Current models include `MiniMax-M3` (1,000,000-token context; adaptive or disabled thinking) and `MiniMax-M2.7` (204,800-token context; always-on thinking). `MiniMax-M3` supports adaptive thinking through `memoryExtraParams`.
- `orcarouter`: OpenAI-compatible model gateway with namespaced model IDs. `memoryApiUrl` and `memoryModel` are optional — they default to `https://api.orcarouter.ai/v1` and `orcarouter/auto` (a routing alias that selects a capable model per request). If you set `memoryModel`, use a namespaced ID such as `openai/gpt-5.5` or `deepseek/deepseek-v4-flash`; OrcaRouter rejects bare model names. Example:
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) also runs gateway-level, zero-trust security for AI agents on the same endpoint — screening every prompt/response and governing every tool call on a default-deny basis, with no application code changes.
- `atlas-cloud`: OpenAI-compatible Chat Completions preset for [Atlas Cloud](https://www.atlascloud.ai). `memoryApiUrl` and `memoryModel` are optional — they default to `https://api.atlascloud.ai/v1` and `deepseek-ai/deepseek-v4-pro`. If `memoryApiKey` is omitted, `ATLASCLOUD_API_KEY` from the environment is used. Example:
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  When this provider is selected, auto-capture / profile prompts, model responses, and relevant conversation context are transmitted to `https://api.atlascloud.ai`.

Troubleshooting:

- Auto-capture failures do not block manual `memory` tool usage.
- If auto-capture reports that a provider is not connected, confirm the provider name with `opencode providers list` and configure that provider in opencode first.
- If a proxy or custom provider returns plain text instead of structured/tool output, choose another model/provider or use one of the manual provider modes above.
- For models that reject `temperature`, add `"memoryTemperature": false` when using manual API configuration.
- For models that reject forced tool calls (`tool_choice: "required"`, e.g. some thinking modes), add `"forceToolChoice": false` when using `openai-chat` / `orcarouter` / `atlas-cloud`.
- For `opencodeProvider` / `opencodeModel` (e.g. DeepSeek V4 thinking), OpenCode still sends forced `tool_choice` for structured output. opencode-mem disables thinking on the internal `opencode-mem-structured` agent (and re-applies that in `chat.params` after variant merge) so auto-capture and profile learning can complete. Your interactive chat agent is unchanged. If capture still fails with a thinking/`tool_choice` error, pick a non-thinking model for `opencodeModel` or configure a complete manual fallback (`memoryModel` + `memoryApiUrl`).
- **`opencode-claude-auth` / Claude Code:** auto-capture uses OpenCode with your authenticated `anthropic` provider. Forced `format: json_schema` often loops with Claude-auth, so opencode-mem uses an auth-preserving **text-JSON** path for `opencodeProvider: "anthropic"` (no forced `StructuredOutput` tools; reply is parsed with Zod). A step watchdog still aborts runaway internal sessions after 2 steps. If capture still fails, configure a complete manual Anthropic API-key fallback (`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`) — Claude Pro/Max OAuth cannot be reused outside OpenCode.
- **Unsupported platforms:** Intel Mac (`darwin/x64`) is not supported — `@tursodatabase/database` and fixed `onnxruntime-node` releases (pinned `1.30.0`) ship no x64 native binding. Use Apple Silicon, Linux, or Windows, or a remote embedding endpoint via `embeddingApiUrl` + `embeddingApiKey`. MLX is not supported.

## Public Subpath Exports

In addition to the main plugin entry, `opencode-mem` exposes one stable subpath
that other opencode plugins can import directly. This avoids having to
reverse-engineer container-tag conventions when writing third-party tools that
read or write into the same memory store.

### `opencode-mem/tags`

Canonical container-tag helpers. The same functions opencode-mem itself uses
to scope auto-captured memories.

```ts
import { getProjectTagInfo, getUserTagInfo, getTags } from "opencode-mem/tags";

// Canonical project tag derived from cwd (git remote URL if present, else
// the project root path). Format: `opencode_project_<sha16>`.
const projectTag = getProjectTagInfo(process.cwd()).tag;

// Canonical user tag derived from `git config user.email`.
// Format: `opencode_user_<sha16>`.
const userTag = getUserTagInfo().tag;

// Both at once.
const { user, project } = getTags(process.cwd());
```

Tags produced by these helpers match what auto-capture writes, so third-party
plugins that call `POST /api/memories` will land in the same shards the rest
of the system already understands. Hand-rolled tags whose substring isn't
`_project_` or `_user_` end up in shadow shards that `/api/stats` and
`/api/memories` silently filter out — using these helpers avoids that pitfall.

## Development & Contribution

Build and test locally:

```bash
bun install
bun run build
bun run typecheck
bun run format
```

This project is actively seeking contributions to become the definitive memory plugin for AI coding agents. Whether you are fixing bugs, adding features, improving documentation, or expanding embedding model support, your contributions are critical. The codebase is well-structured and ready for enhancement. Please open issues with the Issue or Feature request templates, and fill out the pull request template when you submit a PR — we review and merge contributions quickly.

## License & Links

MIT License - see LICENSE file

- **Repository**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **OpenCode Platform**: https://opencode.ai

Inspired by [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
