# Quick Start

Get up and running with OpenCode Memory in 5 minutes.

## Step 1: Installation

Add the plugin to your OpenCode configuration:

**Edit**: `~/.config/opencode/opencode.json` or `opencode.jsonc`

```jsonc
{
  "plugins": [
    "opencode-mem"
  ]
}
```

Restart OpenCode to install the plugin automatically.

## Step 2: Verify Installation

Check that the web interface is running:

```bash
curl http://127.0.0.1:4747/api/stats
```

You should see JSON output with memory statistics.

## Step 3: First Memory

Add your first memory using the memory tool:

```typescript
memory({
  mode: "add",
  content: "I prefer TypeScript over JavaScript for all projects",
  scope: "user",
  type: "preference"
})
```

## Step 4: Search Memory

Search for the memory you just added:

```typescript
memory({
  mode: "search",
  query: "programming language preference",
  scope: "user"
})
```

## Step 5: View Profile

Check your user profile:

```typescript
memory({ mode: "profile" })
```

## Step 6: Web Interface

Open the web interface in your browser:

```
http://127.0.0.1:4747
```

Explore the features:
- Browse all memories
- Search by keyword or similarity
- Edit or delete memories
- View statistics

## Common Operations

### Add Project Memory

Store project-specific information:

```typescript
memory({
  mode: "add",
  content: "This project uses React 18 with Vite and TypeScript",
  scope: "project",
  type: "architecture"
})
```

### List Recent Memories

View recent memories by scope:

```typescript
memory({ mode: "list", scope: "project", limit: 10 })
```

### Delete Memory

Remove a specific memory:

```typescript
memory({ mode: "forget", memoryId: "mem_abc123" })
```

## Memory Scopes

### User Scope

For cross-project information:
- Coding preferences
- Tool preferences
- Communication style
- Work patterns

### Project Scope

For project-specific information:
- Architecture decisions
- Technology stack
- Code conventions
- Bug fixes

## Automatic Memory

### Keyword Triggers

The agent automatically detects memory-related keywords:

- "remember this"
- "don't forget"
- "keep in mind"
- "make a note"
- "save this"

When detected, the agent will offer to save the information.

### Auto-Capture

Enable automatic memory extraction from conversations:

1. Edit config file: `~/.config/opencode/opencode-mem.jsonc`
2. Add API credentials:

```jsonc
{
  "autoCaptureEnabled": true,
  "memoryModel": "gpt-4",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-your-api-key-here"
}
```

3. Restart OpenCode

The system will now automatically extract important information from conversations.

## Web Interface Features

### Search

- **Text Search**: Search by keywords in content
- **Vector Search**: Semantic similarity search
- **Filters**: Filter by scope, type, or tags

### Memory Management

- **Edit**: Click any memory to edit content or metadata
- **Delete**: Remove individual or multiple memories
- **Pin**: Mark important memories to keep them at the top

### Maintenance

- **Cleanup**: Remove old memories based on retention period
- **Deduplication**: Find and remove similar duplicates
- **Migration**: Change embedding model dimensions

## Configuration

### Basic Settings

Edit `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "webServerPort": 4747,
  "similarityThreshold": 0.6,
  "maxMemories": 5,
  "maxProjectMemories": 10
}
```

### Change Port

If port 4747 is in use:

```jsonc
{
  "webServerPort": 4748
}
```

### Change Storage Location

Store database in a different location:

```jsonc
{
  "storagePath": "/path/to/custom/location"
}
```

## Tips and Best Practices

### Memory Content

- Be specific and concise
- Include context when needed
- Use consistent terminology
- Avoid sensitive information

### Scopes

- Use `user` scope for personal preferences
- Use `project` scope for project-specific info
- Keep scopes separate for better organization

### Search

- Use natural language queries
- Be specific for better results
- Adjust similarity threshold if needed

### Maintenance

- Run cleanup periodically to remove old memories
- Use deduplication to prevent redundancy
- Monitor storage usage in web interface

## Next Steps

- [Memory Operations](Memory-Operations) - Detailed tool usage
- [Configuration Guide](Configuration-Guide) - All configuration options
- [Web Interface](Web-Interface) - Complete UI guide
- [Auto-Capture System](Auto-Capture-System) - Automatic memory extraction

## Getting Help

If you encounter issues:

1. Check [Troubleshooting](Troubleshooting) guide
2. Review [Configuration Guide](Configuration-Guide)
3. Open an issue on [GitHub](https://github.com/tickernelz/opencode-mem/issues)
