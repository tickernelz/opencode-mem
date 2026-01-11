# Configuration Guide

Complete reference for all OpenCode Memory configuration options.

## Configuration File

Location: `~/.config/opencode/opencode-mem.jsonc`

Format: JSONC (JSON with comments)

The configuration file is automatically created on first run with default values.

## Complete Configuration Example

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "embeddingDimensions": 768,
  "embeddingApiUrl": "",
  "embeddingApiKey": "",
  "webServerEnabled": true,
  "webServerPort": 4747,
  "webServerHost": "127.0.0.1",
  "maxVectorsPerShard": 50000,
  "autoCleanupEnabled": true,
  "autoCleanupRetentionDays": 30,
  "deduplicationEnabled": true,
  "deduplicationSimilarityThreshold": 0.9,
  "autoCaptureEnabled": true,
  "memoryModel": "gpt-4",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "",
  "autoCaptureTokenThreshold": 10000,
  "autoCaptureMinTokens": 20000,
  "autoCaptureMaxMemories": 10,
  "autoCaptureSummaryMaxLength": 0,
  "autoCaptureContextWindow": 3,
  "similarityThreshold": 0.6,
  "maxMemories": 5,
  "maxProjectMemories": 10,
  "injectProfile": true,
  "keywordPatterns": [],
  "containerTagPrefix": "opencode",
  "maxProfileItems": 5
}
```

## Storage Settings

### storagePath

**Type**: `string`  
**Default**: `~/.opencode-mem/data`

Database storage location. Supports tilde expansion for home directory.

```jsonc
{
  "storagePath": "~/.opencode-mem/data"
}
```

Custom location:

```jsonc
{
  "storagePath": "/mnt/data/opencode-mem"
}
```

### maxVectorsPerShard

**Type**: `number`  
**Default**: `50000`

Maximum vectors per database shard before creating a new shard.

```jsonc
{
  "maxVectorsPerShard": 50000
}
```

Higher values (100000+) reduce shard count but may slow down individual queries.  
Lower values (25000) create more shards but keep each shard fast.

## Embedding Settings

### embeddingModel

**Type**: `string`  
**Default**: `Xenova/nomic-embed-text-v1`

Model name for generating embeddings.

Local models (no API required):

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

Supported local models:
- `Xenova/nomic-embed-text-v1` (768 dimensions)
- `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- `Xenova/all-mpnet-base-v2` (768 dimensions)
- `Xenova/bge-small-en-v1.5` (384 dimensions)
- `Xenova/bge-base-en-v1.5` (768 dimensions)
- `Xenova/bge-large-en-v1.5` (1024 dimensions)

API-based models:

```jsonc
{
  "embeddingModel": "text-embedding-3-small",
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-..."
}
```

### embeddingDimensions

**Type**: `number`  
**Default**: Auto-detected

Vector dimensions for the embedding model. Usually auto-detected.

```jsonc
{
  "embeddingDimensions": 768
}
```

Only set manually if using custom models or API endpoints.

### embeddingApiUrl

**Type**: `string`  
**Default**: `""`

API endpoint for external embedding service (OpenAI-compatible).

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1"
}
```

Leave empty to use local models.

### embeddingApiKey

**Type**: `string`  
**Default**: `""`

API key for external embedding service.

```jsonc
{
  "embeddingApiKey": "sk-your-api-key-here"
}
```

Can also use environment variable `OPENAI_API_KEY`.

## Web Server Settings

### webServerEnabled

**Type**: `boolean`  
**Default**: `true`

Enable or disable the web interface.

```jsonc
{
  "webServerEnabled": true
}
```

Set to `false` to disable web interface and save resources.

### webServerPort

**Type**: `number`  
**Default**: `4747`

HTTP server port for web interface.

```jsonc
{
  "webServerPort": 4747
}
```

Change if port is already in use.

### webServerHost

**Type**: `string`  
**Default**: `127.0.0.1`

Bind address for web server.

```jsonc
{
  "webServerHost": "127.0.0.1"
}
```

Use `0.0.0.0` to allow external access (not recommended for security).

## Search Settings

### similarityThreshold

**Type**: `number`  
**Default**: `0.6`  
**Range**: `0.0` to `1.0`

Minimum cosine similarity for search results.

```jsonc
{
  "similarityThreshold": 0.6
}
```

- Higher values (0.8+): More strict, fewer but more relevant results
- Lower values (0.4-0.6): More lenient, more results but less precise

### maxMemories

**Type**: `number`  
**Default**: `5`

Maximum user-scope memories to inject into context.

```jsonc
{
  "maxMemories": 5
}
```

### maxProjectMemories

**Type**: `number`  
**Default**: `10`

Maximum project-scope memories to inject into context.

```jsonc
{
  "maxProjectMemories": 10
}
```

## Auto-Capture Settings

### autoCaptureEnabled

**Type**: `boolean`  
**Default**: `true`

Enable automatic memory capture from conversations.

```jsonc
{
  "autoCaptureEnabled": true
}
```

Requires `memoryModel`, `memoryApiUrl`, and `memoryApiKey` to be configured.

### memoryModel

**Type**: `string`  
**Default**: `""`  
**Required**: Yes (if auto-capture enabled)

AI model for memory extraction.

```jsonc
{
  "memoryModel": "gpt-4"
}
```

Supported models:
- OpenAI: `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`
- Anthropic: `claude-3-opus`, `claude-3-sonnet`
- Groq: `llama-3.1-70b`, `mixtral-8x7b`

### memoryApiUrl

**Type**: `string`  
**Default**: `""`  
**Required**: Yes (if auto-capture enabled)

API endpoint for memory extraction.

```jsonc
{
  "memoryApiUrl": "https://api.openai.com/v1"
}
```

Other providers:
- Anthropic: `https://api.anthropic.com/v1`
- Groq: `https://api.groq.com/openai/v1`

### memoryApiKey

**Type**: `string`  
**Default**: `""`  
**Required**: Yes (if auto-capture enabled)

API key for memory extraction service.

```jsonc
{
  "memoryApiKey": "sk-your-api-key-here"
}
```
autoCaptureTokenThreshold

**Type**: `number`  
**Default**: `10000`

Token count threshold to trigger memory capture.

```jsonc
{
  "autoCaptureTokenThreshold": 10000
}
```

Lower values trigger more frequently but may capture less important information.

### autoCaptureMinTokens

**Type**: `number`  
**Default**: `20000`

Minimum total tokens before first capture attempt.

```jsonc
{
  "autoCaptureMinTokens": 20000
}
```

Prevents premature captures at conversation start.

### autoCaptureMaxMemories

**Type**: `number`  
**Default**: `10`

Maximum memories to extract per capture.

```jsonc
{
  "autoCaptureMaxMemories": 10
}
```

### autoCaptureSummaryMaxLength

**Type**: `number`  
**Default**: `0`

Maximum length for memory summaries (0 = AI decides).

```jsonc
{
  "autoCaptureSummaryMaxLength": 0
}
```

Set to specific value (e.g., 200) to limit summary length.

### autoCaptureContextWindow

**Type**: `number`  
**Default**: `3`

Number of recent messages to analyze for memory extraction.

```jsonc
{
  "autoCaptureContextWindow": 3
}
```

Higher values provide more context but increase API costs.

## Maintenance Settings

### autoCleanupEnabled

**Type**: `boolean`  
**Default**: `true`

Enable automatic cleanup of old memories.

```jsonc
{
  "autoCleanupEnabled": true
}
```

### autoCleanupRetentionDays

**Type**: `number`  
**Default**: `30`

Number of days to retain memories before cleanup.

```jsonc
{
  "autoCleanupRetentionDays": 30
}
```

Set to `0` to disable retention-based cleanup.

### deduplicationEnabled

**Type**: `boolean`  
**Default**: `true`

Enable automatic deduplication of similar memories.

```jsonc
{
  "deduplicationEnabled": true
}
```

### deduplicationSimilarityThreshold

**Type**: `number`  
**Default**: `0.9`  
**Range**: `0.0` to `1.0`

Similarity threshold for considering memories as duplicates.

```jsonc
{
  "deduplicationSimilarityThreshold": 0.9
}
```

Higher values (0.95+) are more conservative, lower values (0.85) are more aggressive.

## Advanced Settings

### injectProfile

**Type**: `boolean`  
**Default**: `true`

Inject user profile summary into conversation context.

```jsonc
{
  "injectProfile": true
}
```

### keywordPatterns

**Type**: `string[]`  
**Default**: `[]`

Custom regex patterns for keyword detection.

```jsonc
{
  "keywordPatterns": [
    "\\bimportant\\b",
    "\\bcrucial\\b",
    "\\bkey point\\b"
  ]
}
```

Adds to default patterns (remember, memorize, etc.).

### containerTagPrefix

**Type**: `string`  
**Default**: `opencode`

Tag prefix for container-based organization.

```jsonc
{
  "containerTagPrefix": "opencode"
}
```

### maxProfileItems

**Type**: `number`  
**Default**: `5`

Maximum items to include in profile summary.

```jsonc
{
  "maxProfileItems": 5
}
```

## Environment Variables

### OPENAI_API_KEY

Alternative to `embeddingApiKey` and `memoryApiKey`:

```bash
export OPENAI_API_KEY=sk-your-api-key-here
```

## Configuration Validation

The system validates configuration on startup and logs warnings for:

- Invalid port numbers
- Missing required fields (when features enabled)
- Invalid threshold values (must be 0.0-1.0)
- Invalid model names
- Inaccessible storage paths

## Hot Reload

Most configuration changes take effect immediately without restart:

- Search thresholds
- Memory limits
- Keyword patterns
- Maintenance settings

Requires restart:

- Storage path
- Embedding model
- Web server settings
- Database settings

## Performance Tuning

### For Speed

```jsonc
{
  "similarityThreshold": 0.7,
  "maxMemories": 3,
  "maxProjectMemories": 5,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

### For Accuracy

```jsonc
{
  "similarityThreshold": 0.5,
  "maxMemories": 10,
  "maxProjectMemories": 20,
  "embeddingModel": "Xenova/bge-large-en-v1.5"
}
```

### For Low Memory

```jsonc
{
  "maxVectorsPerShard": 25000,
  "autoCleanupRetentionDays": 14,
  "deduplicationEnabled": true,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

## Next Steps

- [Memory Operations](Memory-Operations) - Use the memory tool
- [Auto-Capture System](Auto-Capture-System) - Automatic memory extraction
- [Performance Tuning](Performance-Tuning) - Optimization strategies
