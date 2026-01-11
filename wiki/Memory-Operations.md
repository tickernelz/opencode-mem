# Memory Operations

Complete guide to using the memory tool for storing and retrieving information.

## Memory Tool Overview

The memory tool provides 9 modes for managing persistent memory:

- `add` - Store new memory
- `search` - Find similar memories
- `profile` - View user profile
- `list` - List recent memories
- `forget` - Delete specific memory
- `help` - Display usage guide
- `capture-now` - Trigger manual capture
- `auto-capture-toggle` - Enable/disable auto-capture
- `auto-capture-stats` - View capture statistics

## Add Memory

Store new information with scope and metadata.

### Basic Usage

```typescript
memory({
  mode: "add",
  content: "User prefers TypeScript over JavaScript",
  scope: "user"
})
```

### With Type

```typescript
memory({
  mode: "add",
  content: "This project uses React 18 with Vite",
  scope: "project",
  type: "architecture"
})
```

### Parameters

- `mode`: `"add"` (required)
- `content`: Memory content (required)
- `scope`: `"user"` or `"project"` (required)
- `type`: Memory type (optional)

### Memory Types

Common types (flexible string):

- `preference` - User preferences
- `architecture` - System design decisions
- `workflow` - Process and workflow patterns
- `bug-fix` - Bug solutions and fixes
- `configuration` - Config settings
- `pattern` - Code patterns and conventions
- `request` - User requests and requirements
- `context` - General context information

### Examples

User preference:

```typescript
memory({
  mode: "add",
  content: "Always use double quotes for strings",
  scope: "user",
  type: "preference"
})
```

Project architecture:

```typescript
memory({
  mode: "add",
  content: "API uses REST with JWT authentication",
  scope: "project",
  type: "architecture"
})
```

Bug fix:

```typescript
memory({
  mode: "add",
  content: "Fixed memory leak by clearing interval in useEffect cleanup",
  scope: "project",
  type: "bug-fix"
})
```

## Search Memory

Find memories using vector similarity search.

### Basic Usage

```typescript
memory({
  mode: "search",
  query: "What are my coding preferences?",
  scope: "user"
})
```

### Cross-Scope Search

Search both scopes:

```typescript
memory({
  mode: "search",
  query: "authentication implementation"
})
```

### Parameters

- `mode`: `"search"` (required)
- `query`: Search query (required)
- `scope`: `"user"`, `"project"`, or omit for both (optional)

### Search Behavior

- Uses vector similarity (cosine distance)
- Returns most relevant memories first
- Respects `similarityThreshold` from config
- Limited by `maxMemories` and `maxProjectMemories`

### Examples

Find coding style:

```typescript
memory({
  mode: "search",
  query: "code formatting preferences",
  scope: "user"
})
```

Find project tech stack:

```typescript
memory({
  mode: "search",
  query: "what technologies does this project use",
  scope: "project"
})
```

## View Profile

Display user profile with preferences and patterns.

### Basic Usage

```typescript
memory({ mode: "profile" })
```

### Profile Contents

The profile includes:

**Static Information**:
- User ID
- Creation date
- Total memories

**Dynamic Patterns** (extracted from memories):
- Coding preferences
- Tool preferences
- Communication style
- Work patterns
- Technical knowledge

### Parameters

- `mode`: `"profile"` (required)

### Example Output

```
User Profile:
- Prefers TypeScript over JavaScript
- Uses React for frontend development
- Follows functional programming patterns
- Prefers double quotes for strings
- Uses Prettier for code formatting
```

## List Memories

Retrieve recent memories by scope.

### Basic Usage

```typescript
memory({
  mode: "list",
  scope: "user",
  limit: 10
})
```

### Parameters

- `mode`: `"list"` (required)
- `scope`: `"user"` or `"project"` (required)
- `limit`: Number of memories (optional, default: 10)

### Examples

List recent user memories:

```typescript
memory({
  mode: "list",
  scope: "user",
  limit: 5
})
```

List all project memories:

```typescript
memory({
  mode: "list",
  scope: "project",
  limit: 100
})
```

## Forget Memory

Delete a specific memory by ID.

### Basic Usage

```typescript
memory({
  mode: "forget",
  memoryId: "mem_abc123"
})
```

### Parameters

- `mode`: `"forget"` (required)
- `memoryId`: Memory ID (required)

### Finding Memory IDs

Get memory IDs from:
- List operation results
- Search operation results
- Web interface

### Example

```typescript
memory({ mode: "list", scope: "user", limit: 5 })
```

Output includes IDs:

```
1. [mem_abc123] User prefers TypeScript
2. [mem_def456] Uses React for frontend
```

Delete specific memory:

```typescript
memory({ mode: "forget", memoryId: "mem_abc123" })
```

## Help

Display usage guide and available modes.

### Basic Usage

```typescript
memory({ mode: "help" })
```

Shows:
- Available modes
- Parameter descriptions
- Usage examples
- Configuration tips

## Capture Now

Manually trigger memory capture from recent conversation.

### Basic Usage

```typescript
memory({ mode: "capture-now" })
```

### Requirements

- Auto-capture must be configured
- API credentials must be set
- Recent conversation history available

### Behavior

- Analyzes recent messages
- Extracts important information
- Stores memories with appropriate scope
- Returns capture results

## Auto-Capture Toggle

Enable or disable automatic memory capture.

### Basic Usage

```typescript
memory({ mode: "auto-capture-toggle" })
```

### Behavior

- Toggles current state (on/off)
- Returns new state
- Persists across sessions

### Example

```typescript
memory({ mode: "auto-capture-toggle" })
```

Output:

```
Auto-capture is now: enabled
```

## Auto-Capture Stats

View statistics about automatic memory capture.

### Basic Usage

```typescript
memory({ mode: "auto-capture-stats" })
```

### Statistics Included

- Total captures performed
- Total memories created
- Average memories per capture
- Last capture timestamp
- Token counts

### Example Output

```
Auto-Capture Statistics:
- Total captures: 15
- Total memories: 127
- Average per capture: 8.5
- Last capture: 2026-01-11 10:30:00
- Total tokens processed: 150,000
```

## Best Practices

### Content Guidelines

**Be Specific**:

```typescript
memory({
  mode: "add",
  content: "User prefers 2-space indentation for TypeScript files",
  scope: "user"
})
```

**Include Context**:

```typescript
memory({
  mode: "add",
  content: "API rate limit is 100 requests per minute, implemented using Redis",
  scope: "project"
})
```

**Avoid Redundancy**:

Check existing memories before adding:

```typescript
memory({ mode: "search", query: "indentation preference" })
```

### Scope Selection

**User Scope** - For cross-project information:
- Personal preferences
- General knowledge
- Tool preferences
- Communication style

**Project Scope** - For project-specific information:
- Architecture decisions
- Technology stack
- Code conventions
- Bug fixes
- Feature implementations

### Search Tips

**Use Natural Language**:

```typescript
memory({
  mode: "search",
  query: "How should I format code in this project?"
})
```

**Be Specific**:

```typescript
memory({
  mode: "search",
  query: "React component testing strategy"
})
```

**Adjust Threshold**:

If getting too few results, lower similarity threshold in config:

```jsonc
{
  "similarityThreshold": 0.5
}
```

### Memory Maintenance

**Regular Cleanup**:

Use web interface or API to remove outdated memories.

**Deduplication**:

Run deduplication periodically to remove similar duplicates.

**Review Profile**:

Check profile regularly to ensure accurate representation:

```typescript
memory({ mode: "profile" })
```

## Advanced Usage

### Batch Operations

Add multiple memories:

```typescript
const memories = [
  { content: "Prefers functional components", scope: "user" },
  { content: "Uses React hooks exclusively", scope: "user" },
  { content: "Avoids class components", scope: "user" }
]

memories.forEach(mem => memory({ mode: "add", ...mem }))
```

### Conditional Storage

Store only if not exists:

```typescript
const results = memory({
  mode: "search",
  query: "TypeScript preference",
  scope: "user"
})

if (results.length === 0) {
  memory({
    mode: "add",
    content: "Prefers TypeScript over JavaScript",
    scope: "user"
  })
}
```

### Memory Migration

Move memories between scopes:

```typescript
const userMems = memory({ mode: "list", scope: "user" })

userMems.forEach(mem => {
  if (mem.content.includes("project-specific")) {
    memory({
      mode: "add",
      content: mem.content,
      scope: "project"
    })
    memory({ mode: "forget", memoryId: mem.id })
  }
})
```

## Error Handling

### Common Errors

**Missing Required Parameters**:

```typescript
memory({ mode: "add" })
```

Error: `content and scope are required`

**Invalid Scope**:

```typescript
memory({ mode: "add", content: "test", scope: "invalid" })
```

Error: `scope must be 'user' or 'project'`

**Memory Not Found**:

```typescript
memory({ mode: "forget", memoryId: "invalid_id" })
```

Error: `Memory not found`

### Validation

The tool validates:
- Required parameters
- Parameter types
- Scope values
- Memory ID format

## Next Steps

- [Web Interface](Web-Interface) - Manage memories visually
- [Auto-Capture System](Auto-Capture-System) - Automatic extraction
- [Configuration Guide](Configuration-Guide) - Customize behavior
