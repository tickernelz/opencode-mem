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

Local vector database with SQLite + HNSW (hnswlib-wasm), persistent project memories, automatic user profile learning, unified memory-prompt timeline, full-featured web UI, intelligent prompt-based memory extraction, multi-provider AI support (OpenAI, Anthropic), 12+ local embedding models, smart deduplication, and built-in privacy protection.

## Team Knowledge Base

The Team Knowledge Base automatically extracts and manages technical knowledge from your codebase, providing AI agents with rich context about project architecture, tech stack, coding standards, and lessons learned.

### Knowledge Categories

| Type                | Description                                      | Source                                             |
| ------------------- | ------------------------------------------------ | -------------------------------------------------- |
| **tech-stack**      | Runtime dependencies, frameworks, engines        | package.json, go.mod, requirements.txt, Dockerfile |
| **architecture**    | Project structure, design patterns, entry points | Directory structure analysis                       |
| **coding-standard** | Linting rules, formatting, compiler options      | ESLint, Prettier, TSConfig, Biome, EditorConfig    |
| **lesson**          | Lessons learned from bug fixes and discussions   | AI analysis of project memories                    |
| **business-logic**  | Core business concepts and domain logic          | JSDoc comments from service/domain files           |

### Using the Team Knowledge Tool

```typescript
// Search knowledge base
team_knowledge({ mode: "search", query: "authentication flow" });

// List all knowledge items
team_knowledge({ mode: "list" });

// List by type
team_knowledge({ mode: "list", type: "architecture" });

// Get statistics
team_knowledge({ mode: "stats" });

// Manually trigger sync
team_knowledge({ mode: "sync" });
```

### Automatic Knowledge Sync

Knowledge extraction runs automatically when your session goes idle (configurable). The sync process:

1. Runs rule-based extractors (zero AI cost) for tech-stack, architecture, coding-standard
2. Runs AI-enhanced extractors for lessons and business-logic (requires AI provider config)
3. Computes incremental diff based on source keys
4. Updates only changed entries, preserving version history
5. Marks removed entries as stale (cleaned after retention period)

### Context Injection

Team knowledge is automatically injected into AI conversations:

- **First message**: Overview context (tech-stack summary, coding standards)
- **Subsequent messages**: Semantically relevant knowledge based on query

### Team Knowledge Configuration

```jsonc
{
  // Enable/disable team knowledge feature
  "teamKnowledgeEnabled": true,

  // Auto-sync when session goes idle
  "teamKnowledgeSyncOnIdle": true,

  // Inject overview context on first message
  "teamKnowledgeInjectOverview": true,

  // Inject relevant knowledge based on semantic search
  "teamKnowledgeInjectRelevant": true,

  // Max knowledge items to inject per message
  "teamKnowledgeMaxInject": 5,

  // Days to retain stale entries before deletion
  "teamKnowledgeStaleRetentionDays": 7,

  // Which extractors to run
  "teamKnowledgeExtractors": [
    "tech-stack",
    "architecture",
    "coding-standard",
    "lesson",
    "business-logic",
  ],
}
```

### Web UI

The Team Knowledge tab in the web interface (`http://127.0.0.1:4747`) provides:

- Filter by knowledge type
- View knowledge details with source info
- Manual sync trigger
- Statistics dashboard
- Delete individual entries

## Prerequisites

This plugin uses `hnswlib-node` for fast vector similarity search, which requires native compilation. Ensure you have:

**All platforms:**

- Python 3.x
- A C++ compiler (gcc, clang, or MSVC)
- `make` or CMake

**Platform-specific setup:**

| Platform    | Requirements                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | Xcode Command Line Tools: `xcode-select --install`                                                                        |
| **Linux**   | Build essentials: `sudo apt install build-essential python3` (Debian/Ubuntu) or `sudo pacman -S base-devel python` (Arch) |
| **Windows** | Visual Studio Build Tools with C++ workload, or Windows Build Tools: `npm install -g windows-build-tools`                 |

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
  "memoryProvider": "openai-chat",
  "memoryModel": "gpt-4o-mini",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-...",
  "memoryTemperature": 0.3,

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
