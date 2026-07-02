# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)

![OpenCode Memory Banner](.github/banner.png)

A persistent memory system for AI coding agents that enables long-term context retention across sessions using local vector database technology.

## Visual Overview

**Project Memory Timeline:**

![Project Memory Timeline](.github/screenshot-project-memory.png)

**User Profile Viewer:**

![User Profile Viewer](.github/screenshot-user-profile.png)

## Core Features

Local vector database with SQLite + USearch-first vector indexing and ExactScan fallback, persistent project memories, automatic user profile learning, unified memory-prompt timeline, full-featured web UI, intelligent prompt-based memory extraction, multi-provider AI support (OpenAI, Anthropic), 12+ local embedding models, smart deduplication, and built-in privacy protection.

## Prerequisites

This plugin uses `USearch` for preferred in-memory vector indexing with automatic ExactScan fallback. No custom SQLite build or browser runtime shim is required.

**Recommended runtime:**

- Bun
- Standard OpenCode plugin environment
- Internet access on first use if you use the default local embedding model, because the model is downloaded by `@huggingface/transformers`.
- For source/development installs, run `bun install` before building or testing. The published plugin package installs its runtime dependencies automatically through OpenCode.

**Notes:**

- If `USearch` is unavailable or fails at runtime, the plugin automatically falls back to exact vector scanning.
- SQLite remains the source of truth; search indexes are rebuilt from SQLite data when needed.
- Auto-capture and user profile learning require an AI provider that can return structured/tool-call output. Memory search/add/list still work without auto-capture provider configuration.

## Getting Started

Add to your OpenCode configuration at `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-mem"],
}
```

The plugin downloads automatically on next startup.

## Usage Examples

```typescript
memory({ mode: "add", content: "Project uses microservices architecture" });
memory({ mode: "search", query: "architecture decisions" });
memory({ mode: "search", query: "architecture decisions", scope: "all-projects" });
memory({ mode: "profile" });
memory({ mode: "list", limit: 10 });
```

Access the web interface at `http://127.0.0.1:4747` for visual memory browsing and management.

## Configuration Essentials

Configure at `~/.config/opencode/opencode-mem.jsonc`:

The plugin creates a full commented template at this path on first startup. This trimmed example shows the most common settings:

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "userEmailOverride": "user@example.com",
  "userNameOverride": "John Doe",
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  // Optional OpenAI-compatible embedding endpoint:
  // "embeddingApiUrl": "https://api.openai.com/v1",
  // "embeddingApiKey": "env://OPENAI_API_KEY",
  // "embeddingModel": "text-embedding-3-small",

  "memory": {
    "defaultScope": "project",
  },
  "webServerEnabled": true,
  "webServerPort": 4747,

  "autoCaptureEnabled": true,
  "autoCaptureLanguage": "auto",

  "opencodeProvider": "anthropic",
  "opencodeModel": "claude-haiku-4-5-20251001",

  // Manual fallback if you do not use opencodeProvider:
  // "memoryProvider": "openai-chat",
  // "memoryModel": "gpt-4o-mini",
  // "memoryApiUrl": "https://api.openai.com/v1",
  // "memoryApiKey": "env://OPENAI_API_KEY",

  "showAutoCaptureToasts": true,
  "showUserProfileToasts": true,
  "showErrorToasts": true,

  "userProfileAnalysisInterval": 10,
  "maxMemories": 10,

  "compaction": {
    "enabled": true,
    "memoryLimit": 10,
  },
  "chatMessage": {
    "enabled": true,
    "maxMemories": 3,
    "excludeCurrentSession": true,
    "maxAgeDays": undefined,
    "injectOn": "first",
  },
}
```

### Memory Scope

- `scope: "project"`: query only the current project. This is the default.
- `scope: "all-projects"`: query `search` / `list` across all project shards.
- `memory.defaultScope` sets the default query scope when no explicit scope is provided.

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

**Follow the session model:** set `"opencodeModel": "inherit"` to capture each prompt with the exact provider/model opencode used to answer it (recorded per message via the `chat.params` hook). This is useful if you switch models often or use several local backends; captures then always use the model that produced the conversation, and pinned ids can’t become stale. `opencodeProvider` is still required as the normal config gate, and is used if a prompt has no recorded model.

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

Troubleshooting:

- Auto-capture failures do not block manual `memory` tool usage.
- If auto-capture reports that a provider is not connected, confirm the provider name with `opencode providers list` and configure that provider in opencode first.
- If a proxy or custom provider returns plain text instead of structured/tool output, choose another model/provider or use one of the manual provider modes above.
- For models that reject `temperature`, add `"memoryTemperature": false` when using manual API configuration.

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

This project is actively seeking contributions to become the definitive memory plugin for AI coding agents. Whether you are fixing bugs, adding features, improving documentation, or expanding embedding model support, your contributions are critical. The codebase is well-structured and ready for enhancement. If you hit a blocker or have improvement ideas, submit a pull request - we review and merge contributions quickly.

## License & Links

MIT License - see LICENSE file

- **Repository**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **OpenCode Platform**: https://opencode.ai

Inspired by [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
