# Auto-Capture System

Comprehensive guide to automatic memory extraction from conversations.

## Overview

The auto-capture system automatically extracts important information from conversations using AI, eliminating the need for manual memory creation.

## How It Works

### Process Flow

1. **Monitor Conversation**: Tracks token count in real-time
2. **Trigger Detection**: Activates when threshold is reached
3. **Context Analysis**: Analyzes recent messages using AI
4. **Memory Extraction**: Identifies important information
5. **Scope Assignment**: Determines user vs project scope
6. **Storage**: Saves memories to database
7. **Background Processing**: Runs without blocking conversation

### Token-Based Triggering

**Threshold System**:
- Monitors cumulative token count
- Triggers at configurable threshold (default: 10,000 tokens)
- Resets counter after capture
- Prevents premature captures with minimum threshold

**Why Token-Based**:
- Ensures sufficient context
- Prevents excessive API calls
- Balances cost and coverage
- Adapts to conversation length

## Configuration

### Required Settings

Auto-capture requires API credentials:

```jsonc
{
  "autoCaptureEnabled": true,
  "memoryModel": "gpt-4",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-your-api-key-here"
}
```

### Optional Settings

```jsonc
{
  "autoCaptureTokenThreshold": 10000,
  "autoCaptureMinTokens": 20000,
  "autoCaptureMaxMemories": 10,
  "autoCaptureSummaryMaxLength": 0,
  "autoCaptureContextWindow": 3
}
```

## Configuration Options

### autoCaptureEnabled

**Type**: `boolean`  
**Default**: `true`

Enable or disable auto-capture.

```jsonc
{
  "autoCaptureEnabled": true
}
```

### memoryModel

**Type**: `string`  
**Required**: Yes

AI model for memory extraction.

**Supported Models**:

OpenAI:
```jsonc
{
  "memoryModel": "gpt-4"
}
```

Anthropic:
```jsonc
{
  "memoryModel": "claude-3-opus-20240229",
  "memoryApiUrl": "https://api.anthropic.com/v1"
}
```

Groq:
```jsonc
{
  "memoryModel": "llama-3.1-70b-versatile",
  "memoryApiUrl": "https://api.groq.com/openai/v1"
}
```

**Model Selection**:
- GPT-4: Best quality, higher cost
- GPT-3.5-Turbo: Good balance
- Claude-3-Opus: Excellent quality
- Llama-3.1-70b: Fast, cost-effective

### memoryApiUrl

**Type**: `string`  
**Required**: Yes

API endpoint for memory extraction.

**Provider URLs**:

```jsonc
{
  "memoryApiUrl": "https://api.openai.com/v1"
}
```

```jsonc
{
  "memoryApiUrl": "https://api.anthropic.com/v1"
}
```

```jsonc
{
  "memoryApiUrl": "https://api.groq.com/openai/v1"
}
```

### memoryApiKey

**Type**: `string`  
**Required**: Yes

API key for authentication.

```jsonc
{
  "memoryApiKey": "sk-your-api-key-here"
}
```

**Environment Variable**:

Alternatively, set environment variable:

```bash
export OPENAI_API_KEY=sk-your-api-key-here
```

### autoCaptureTokenThreshold

**Type**: `number`  
**Default**: `10000`

Token count to trigger capture.

```jsonc
{
  "autoCaptureTokenThreshold": 10000
}
```

**Tuning**:
- Lower (5000): More frequent captures, higher cost
- Default (10000): Balanced
- Higher (20000): Less frequent, lower cost

### autoCaptureMinTokens

**Type**: `number`  
**Default**: `20000`

Minimum total tokens before first capture.

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

**Tuning**:
- Lower (5): Fewer, more important memories
- Default (10): Balanced
- Higher (20): More comprehensive, higher cost

### autoCaptureSummaryMaxLength

**Type**: `number`  
**Default**: `0` (AI decides)

Maximum length for memory summaries.

```jsonc
{
  "autoCaptureSummaryMaxLength": 200
}
```

Set to `0` to let AI determine optimal length.

### autoCaptureContextWindow

**Type**: `number`  
**Default**: `3`

Number of recent messages to analyze.

```jsonc
{
  "autoCaptureContextWindow": 3
}
```

**Tuning**:
- Lower (1-2): Faster, less context
- Default (3): Balanced
- Higher (5+): More context, higher cost

## Usage

### Automatic Operation

Once configured, auto-capture runs automatically:

1. Have conversations with the AI agent
2. System monitors token count
3. Captures trigger automatically
4. Memories stored in background
5. No user interaction required

### Manual Trigger

Force immediate capture:

```typescript
memory({ mode: "capture-now" })
```

Useful for:
- Capturing important conversation immediately
- Testing auto-capture configuration
- Forcing capture before threshold

### Toggle Auto-Capture

Enable or disable at runtime:

```typescript
memory({ mode: "auto-capture-toggle" })
```

Returns new state:

```
Auto-capture is now: enabled
```

### View Statistics

Check auto-capture performance:

```typescript
memory({ mode: "auto-capture-stats" })
```

Returns:
- Total captures performed
- Total memories created
- Average memories per capture
- Last capture timestamp
- Token counts

## Memory Extraction

### What Gets Captured

**User Scope**:
- Personal preferences
- Coding style
- Tool preferences
- Communication patterns
- General knowledge

**Project Scope**:
- Architecture decisions
- Technology choices
- Implementation details
- Bug fixes
- Feature requirements

### Extraction Quality

**Factors Affecting Quality**:

1. **Model Selection**: Better models extract more accurately
2. **Context Window**: More context improves relevance
3. **Conversation Quality**: Clear discussions yield better memories
4. **Token Threshold**: Sufficient context ensures completeness

**Optimization**:

For best results:
- Use GPT-4 or Claude-3-Opus
- Set context window to 3-5 messages
- Maintain clear, structured conversations
- Provide explicit context when needed

## Cost Management

### Estimating Costs

**Per Capture**:
- Context window: 3 messages ≈ 1,000 tokens
- Model call: ~$0.01-0.03 per capture (GPT-4)
- Frequency: Every 10,000 tokens

**Monthly Estimate**:
- Active usage: 100,000 tokens/day
- Captures: ~10 per day
- Cost: ~$3-9/month (GPT-4)

### Cost Reduction

**Use Cheaper Models**:

```jsonc
{
  "memoryModel": "gpt-3.5-turbo"
}
```

Reduces cost by 90% with slight quality decrease.

**Increase Threshold**:

```jsonc
{
  "autoCaptureTokenThreshold": 20000
}
```

Halves capture frequency.

**Reduce Context Window**:

```jsonc
{
  "autoCaptureContextWindow": 2
}
```

Reduces tokens per capture.

**Limit Max Memories**:

```jsonc
{
  "autoCaptureMaxMemories": 5
}
```

Reduces processing time and cost.

## Monitoring

### Check Status

View auto-capture statistics:

```typescript
memory({ mode: "auto-capture-stats" })
```

### Web Interface

Access statistics in web interface:

1. Open `http://127.0.0.1:4747`
2. Click "Statistics" tab
3. View "Auto-Capture" section

### Logs

Check OpenCode logs for capture events:

```
[AutoCapture] Triggered at 10,000 tokens
[AutoCapture] Analyzing 3 messages
[AutoCapture] Extracted 8 memories
[AutoCapture] Stored 5 user, 3 project memories
```

## Troubleshooting

### Auto-Capture Not Working

**Verify Configuration**:

```jsonc
{
  "autoCaptureEnabled": true,
  "memoryModel": "gpt-4",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-..."
}
```

**Check API Key**:

Test API key:

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer sk-your-api-key"
```

**Check Token Count**:

Ensure conversation has reached minimum threshold:

```typescript
memory({ mode: "auto-capture-stats" })
```

### No Memories Extracted

**Increase Context Window**:

```jsonc
{
  "autoCaptureContextWindow": 5
}
```

**Lower Threshold**:

```jsonc
{
  "autoCaptureTokenThreshold": 5000
}
```

**Check Conversation Quality**:

Ensure conversations contain extractable information.

### Too Many Memories

**Reduce Max Memories**:

```jsonc
{
  "autoCaptureMaxMemories": 5
}
```

**Increase Threshold**:

```jsonc
{
  "autoCaptureTokenThreshold": 15000
}
```

**Enable Deduplication**:

```jsonc
{
  "deduplicationEnabled": true
}
```

### High API Costs

**Switch to Cheaper Model**:

```jsonc
{
  "memoryModel": "gpt-3.5-turbo"
}
```

**Increase Threshold**:

```jsonc
{
  "autoCaptureTokenThreshold": 20000
}
```

**Reduce Context Window**:

```jsonc
{
  "autoCaptureContextWindow": 2
}
```

## Best Practices

### Configuration

**Start Conservative**:

```jsonc
{
  "autoCaptureTokenThreshold": 15000,
  "autoCaptureMaxMemories": 5,
  "autoCaptureContextWindow": 3
}
```

**Monitor and Adjust**:

Check statistics regularly and tune based on results.

**Use Appropriate Model**:

Balance cost and quality based on needs.

### Conversation

**Be Explicit**:

State important information clearly.

**Provide Context**:

Explain decisions and reasoning.

**Structured Discussions**:

Organize conversations logically.

### Maintenance

**Review Captured Memories**:

Periodically check quality of auto-captured memories.

**Run Deduplication**:

Remove duplicate memories created by auto-capture.

**Adjust Settings**:

Fine-tune based on memory quality and cost.

## Advanced Usage

### Custom Prompts

Modify extraction prompt (requires code changes):

```typescript
const prompt = `
Extract important information from this conversation.
Focus on: ${customFocus}
Format: ${customFormat}
`
```

### Selective Capture

Capture only specific types:

```typescript
if (conversationContains("architecture")) {
  memory({ mode: "capture-now" })
}
```

### Integration with Workflows

Trigger capture at specific points:

```typescript
afterCodeReview(() => {
  memory({ mode: "capture-now" })
})
```

## Next Steps

- [Memory Operations](Memory-Operations) - Manual memory management
- [Configuration Guide](Configuration-Guide) - All configuration options
- [Performance Tuning](Performance-Tuning) - Optimization strategies
