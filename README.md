# opencode-mem

OpenCode plugin for persistent memory using local vector database.

Your agent remembers what you tell it - across sessions, across projects. No API keys required.

## Installation

### For Humans

```bash
bunx opencode-mem@latest install
```

**Or let your agent do it** - paste this into OpenCode:
```
Install opencode-mem by following https://raw.githubusercontent.com/tickernelz/opencode-mem/main/README.md
```

### For LLM Agents

<details>
<summary>Instructions for LLM Agents (click to expand)</summary>

If you're an LLM agent helping set up opencode-mem, follow these steps:

#### Step 1: Run the installer

```bash
bunx opencode-mem@latest install --no-tui
```

This will:
- Register the plugin in `~/.config/opencode/opencode.jsonc`
- Create the `/mem-init` command

#### Step 2: Verify the config

```bash
cat ~/.config/opencode/opencode.jsonc
```

Should contain:
```json
{
  "plugin": ["opencode-mem"]
}
```

If not, add it manually:

**JSONC:**
```jsonc
{
  "plugin": [
    "opencode-mem"
  ]
}
```

**JSON:**
```json
{
  "plugin": ["opencode-mem"]
}
```

#### Step 3: Verify setup

Tell the user to restart OpenCode and run:

```bash
opencode -c
```

They should see `memory` in the tools list. If not, check logs: `tail ~/.opencode-mem.log`

#### Step 4: Initialize codebase memory (optional)

Run `/mem-init` to have the agent explore and memorize the codebase.

</details>

## Features

### Context Injection

On first message, the agent receives (invisible to user):
- User profile (cross-project preferences)
- Project memories (all project knowledge)
- Relevant user memories (semantic search)

Example of what the agent sees:
```
[MEMORY]

User Profile:
- Prefers concise responses
- Expert in TypeScript

Project Knowledge:
- [100%] Uses Bun, not Node.js
- [100%] Build: bun run build

Relevant Memories:
- [82%] Build fails if .env.local missing
```

The agent uses this context automatically - no manual prompting needed.

### Keyword Detection

Say "remember", "save this", "don't forget" etc. and the agent auto-saves to memory.

```
You: "Remember that this project uses bun"
Agent: [saves to project memory]
```

Add custom triggers via `keywordPatterns` config.

### Codebase Indexing

Run `/mem-init` to explore and memorize your codebase structure, patterns, and conventions.

### Preemptive Compaction

When context hits 80% capa:
1. Triggers OpenCode's summarization
2. Injects project memories into summary context
3. Saves session summary as a memory

This preserves conversation context across compaction events.

### Privacy

```
API key is <private>sk-abc123</private>
```

Content in `<private>` tags is never stored.

## Tool Usage

The `memory` tool is available to the agent:

| Mode | Args | Description |
|------|------|-------------|
| `add` | `content`, `type?`, `scope?` | Store memory |
| `search` | `query`, `scope?` | Search memories |
| `profile` | `query?` | View user profile |
| `list` | `scope?`, `limit?` | List memories |
| `forget` | `memoryId`, `scope?` | Delete memory |

**Scopes:** `user` (cross-project), `project` (default)

**Types:** `project-config`, `architecture`, `error-solution`, `preference`, `learned-pattern`, `conversation`

## Memory Scoping

| Scope | Tag | Persists |
|-------|-----|----------|
| User | `opencode_user_{sha256(git email)}` | All projects |
| Project | `opencode_project_{sha256(directory)}` | This project |

## Configuration

Create `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-...",
  
  "similarityThreshold": 0.6,
  
  "maxMemories": 5,
  
  "maxProjectMemories": 10,
  
  "maxProfileItems": 5,
  
  "injectProfile": true,
  
  "containerTagPrefix": "opencode",
  
  "keywordPatterns": ["log\\s+this", "write\\s+down"]
}
```

All fields optional.

### Embedding Options

**Local (default):**
- Model: `Xenova/all-MiniLM-L6-v2` (~23MB)
- No API key required
- Runs on first use

**OpenAI-compatible API:**
- Set `embeddingApiUrl` and `embeddingApiKey`
- Supports OpenAI, Azure OpenAI, or any compatible endpoint
- Model name in `embeddingModel`

**Alternative local models:**
- `Xenova/all-mpnet-base-v2` (better quality, ~420MB)
- `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (multilingual)

## Usage with Oh My OpenCode

If you're using [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode), disable its built-in auto-compact hook to let opencode-mem handle context compaction:

Add to `~/.config/opencode/oh-my-opencode.json`:

```json
{
  "disabled_hooks": ["anthropic-context-window-limit-recovery"]
}
```

## Develt

```bash
bun install
bun run build
bun run typecheck
```

Local install:

```jsonc
{
  "plugin": ["file:///path/to/opencode-mem"]
}
```

## Logs

```bash
tail -f ~/.opencode-mem.log
```

## Architecture

- **Storage**: LanceDB (embedded vector database)
- **Embeddings**: Local transformers or OpenAI-compatible API
- **Data**: `~/.opencode-mem/data/`
- **No external dependencies**: Fully standalone

## License

MIT
