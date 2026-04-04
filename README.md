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

**Notes:**

- If `USearch` is unavailable or fails at runtime, the plugin automatically falls back to exact vector scanning.
- SQLite remains the source of truth; search indexes are rebuilt from SQLite data when needed.

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
memory({ mode: "profile" });
memory({ mode: "list", limit: 10 });
```

Access the web interface at `http://127.0.0.1:4747` for visual memory browsing and management.

## Configuration Essentials

Configure at `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "userEmailOverride": "user@example.com",
  "userNameOverride": "John Doe",
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "webServerEnabled": true,
  "webServerPort": 4747,

  "autoCaptureEnabled": true,
  "autoCaptureLanguage": "auto",

  "opencodeProvider": "anthropic",
  "opencodeModel": "claude-haiku-4-5-20251001",

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
    "injectOn": "first",
    "selection": "recent",
    "semantic": {
      "minSimilarity": 0.6,
    },
  },
}
```

### Chat Message Memory Injection

The plugin can inject relevant memories into each message's context automatically. Enable this via `chatMessage.enabled` and choose how memories are selected with `chatMessage.selection`.

**Selection modes:**

| Mode         | Description                                                            | Latency impact                  |
| ------------ | ---------------------------------------------------------------------- | ------------------------------- |
| `"recent"`   | Inject the most recently saved memories (default)                      | None                            |
| `"semantic"` | Inject memories most semantically similar to the current message       | +1 embedding lookup per message |
| `"hybrid"`   | Combine semantic similarity with recency fill-up for highest relevance | +1 embedding lookup per message |

Semantic and hybrid modes are **opt-in**. The default `"recent"` mode adds zero latency. Switch to `"semantic"` or `"hybrid"` when relevance matters more than speed.

The `chatMessage.semantic.minSimilarity` threshold controls how strictly memories must match (0 to 1). Lower values surface more memories; higher values are stricter. The default `0.6` works well for most use cases.

```jsonc
"chatMessage": {
  "selection": "semantic",   // or "hybrid"
  "semantic": {
    "minSimilarity": 0.6     // raise to 0.75+ for stricter matching
  }
}
```

**Troubleshooting injection behavior:**

Set `chatMessage.debug: true` to enable verbose `[DEBUG]` entries in the log file. Debug logs include the active selection branch, assistant-tail summary, semantic query prefix (≤200 chars), retrieval parameters, result counts per source, and elapsed timing. Memory content is never logged — only counts. Query snippets are truncated to protect privacy.

> **Warning:** Debug logging is verbose and intended for temporary troubleshooting only. Leave `debug: false` (or omit it) in normal use.

```jsonc
"chatMessage": {
  "debug": true   // enable temporarily; remove when done
}
```

Logs are written to `~/.opencode-mem/opencode-mem.log`. Follow live:

```bash
tail -f ~/.opencode-mem/opencode-mem.log
```

### Auto-Capture AI Provider

**Recommended:** Use opencode's built-in providers (no separate API key needed):

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

This leverages your existing opencode authentication (OAuth or API key). Works with Claude Pro/Max plans via OAuth - no individual API keys required.

Supported providers: `anthropic`, `openai`

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

Full documentation available in this README.

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
