# opencode-supermemory

OpenCode plugin for persistent memory using [Supermemory](https://supermemory.ai).

## Installation

```bash
npx opencode-supermemory setup
```

Interactive wizard that:
1. Installs plugin globally
2. Creates `/supermemory-init` command
3. Adds plugin to OpenCode config

Then set your API key:

```bash
export SUPERMEMORY_API_KEY="your-api-key"  # from console.supermemory.ai
```

## Features

### Context Injection

On first message, injects:
- User profile (cross-project preferences)
- Project memories (all project knowledge)
- Relevant user memories (semantic search)

```
[SUPERMEMORY]

User Profile:
- Prefers concise responses
- Expert in TypeScript

Project Knowledge:
- [100%] Uses Bun, not Node.js
- [100%] Build: bun run build

Relevant Memories:
- [82%] Build fails if .env.local missing
```

### Keyword Detection

Say "remember", "save this", "don't forget" etc. and the agent auto-saves to memory.

```
You: "Remember that this project uses bun"
Agent: [saves to project memory]
```

### Codebase Indexing

Run `/supermemory-init` to explore and memorize your codebase structure, patterns, and conventions.

### Preemptive Compaction

When context hits 80% capacity:
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

The `supermemory` tool is available to the agent:

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

Create `~/.config/opencode/supermemory.jsonc`:

```jsonc
{
  // API key (can also use SUPERMEMORY_API_KEY env var)
  "apiKey": "sm_...",
  
  // Min similarity for memory retrieval (0-1)
  "similarityThreshold": 0.6,
  
  // Max memories injected per request
  "maxMemories": 5,
  
  // Max project memories listed
  "maxProjectMemories": 10,
  
  // Max profile facts injected
  "maxProfileItems": 5,
  
  // Include user profile in context
  "injectProfile": true,
  
  // Prefix for container tags
  "containerTagPrefix": "opencode"
}
```

All fields optional. Env var `SUPERMEMORY_API_KEY` takes precedence over config file.

API timeout: 5s

## Hooks

Registered in `package.json`:
- `chat.message` - Context injection on first message, keyword detection
- `event` - Compaction monitoring and summary capture

## Development

```bash
bun install
bun run build
bun run typecheck
```

Local install:

```jsonc
{
  "plugin": ["file:///path/to/opencode-supermemory"]
}
```

## Logs

```bash
tail -f ~/.opencode-supermemory.log
```

## License

MIT
