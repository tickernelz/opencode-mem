# OpenCode Memory

![OpenCode Memory Banner](.github/banner.png)

A persistent memory system for AI coding agents that enables long-term context retention across sessions using local vector database technology.

## Overview

OpenCode Memory provides AI coding agents with the ability to remember and recall information across conversations. It uses vector embeddings and SQLite for efficient storage and retrieval of contextual information.

## Key Features

- **Local Vector Database**: SQLite-based storage with sqlite-vec extension
- **Project Memory System**: Persistent storage for project-specific knowledge
- **User Profile System**: Automatic learning of preferences, patterns, and workflows
- **Unified Timeline**: Browse memories and prompts together with linking support
- **Web Interface**: Full-featured UI for memory management and search
- **Auto-Capture System**: Intelligent prompt-based memory extraction
- **Multi-Provider AI**: Support for OpenAI, Anthropic, and OpenAI-compatible APIs
- **Flexible Embedding Models**: 12+ local models or OpenAI-compatible APIs
- **Smart Deduplication**: Prevents redundant memories using similarity detection
- **Privacy Protection**: Built-in content filtering for sensitive information

## Installation

Add the plugin to your OpenCode configuration:

**Location**: `~/.config/opencode/opencode.json` or `opencode.jsonc`

```jsonc
{
  "plugins": [
    "opencode-mem"
  ]
}
```

OpenCode will automatically download and install the plugin on next startup.

### Install from Source

```bash
git clone https://github.com/tickernelz/opencode-mem.git
cd opencode-mem
bun install
bun run build
```

## Quick Start

### Basic Usage

```typescript
// Add project memory
memory({ mode: "add", content: "Project uses microservices architecture" })

// Search memories
memory({ mode: "search", query: "architecture decisions" })

// View user profile
memory({ mode: "profile" })

// List recent memories
memory({ mode: "list", limit: 10 })
```

### Web Interface

Access at `http://127.0.0.1:4747` to browse memories, view prompt-memory links, and manage your memory database.

**Project Memory Timeline:**

![Project Memory Timeline](.github/screenshot-project-memory.png)

**User Profile Viewer:**

![User Profile Viewer](.github/screenshot-user-profile.png)

## Configuration

Configuration file: `~/.config/opencode/opencode-mem.jsonc`

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "webServerEnabled": true,
  "webServerPort": 4747,
  "autoCaptureEnabled": true,
  "memoryProvider": "openai-chat",
  "memoryModel": "gpt-4",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-...",
  "userProfileAnalysisInterval": 10,
  "maxMemories": 10
}
```

See [Configuration Guide](https://github.com/tickernelz/opencode-mem/wiki/Configuration-Guide) for all options.

## Breaking Changes (v2.3)

**User-scoped memories completely removed:**

- **Removed**: `scope` parameter from all memory operations
- **Removed**: `maxProjectMemories` config (use `maxMemories` instead)
- **Renamed**: `userMemoryAnalysisInterval` → `userProfileAnalysisInterval`
- **Renamed**: `performUserMemoryLearning()` → `performUserProfileLearning()`
- **Changed**: All memories are now project-scoped by default
- **Changed**: User preferences managed exclusively through automatic profile system

**Migration required:**
```jsonc
// OLD
{
  "userMemoryAnalysisInterval": 10,
  "maxMemories": 5,
  "maxProjectMemories": 10
}

// NEW
{
  "userProfileAnalysisInterval": 10,
  "maxMemories": 10
}
```

Remove `scope` parameter from all `memory()` calls:
```typescript
// OLD
memory({ mode: "add", content: "...", scope: "project" })

// NEW
memory({ mode: "add", content: "..." })
```

## Documentation

For detailed documentation, see the [Wiki](https://github.com/tickernelz/opencode-mem/wiki):

- [Installation Guide](https://github.com/tickernelz/opencode-mem/wiki/Installation-Guide)
- [Quick Start](https://github.com/tickernelz/opencode-mem/wiki/Quick-Start)
- [Configuration Guide](https://github.com/tickernelz/opencode-mem/wiki/Configuration-Guide)
- [User Profile System](https://github.com/tickernelz/opencode-mem/wiki/User-Profile-System)
- [Memory Operations](https://github.com/tickernelz/opencode-mem/wiki/Memory-Operations)
- [Auto-Capture System](https://github.com/tickernelz/opencode-mem/wiki/Auto-Capture-System)
- [Web Interface](https://github.com/tickernelz/opencode-mem/wiki/Web-Interface)
- [API Reference](https://github.com/tickernelz/opencode-mem/wiki/API-Reference)
- [Troubleshooting](https://github.com/tickernelz/opencode-mem/wiki/Troubleshooting)

## Development

```bash
bun install
bun run dev
bun run build
bun run format
bun run typecheck
```

## License

MIT License - see LICENSE file for details

## Acknowledgments

Inspired by [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)

## Links

- **Repository**: https://github.com/tickernelz/opencode-mem
- **Wiki**: https://github.com/tickernelz/opencode-mem/wiki
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **OpenCode Platform**: https://opencode.ai
