# Embedding Models

Complete guide to embedding models for vector generation in OpenCode Memory.

## Overview

Embedding models convert text into numerical vectors for similarity search. OpenCode Memory supports both local models (no API required) and external API-based models.

## Local Models

Local models run entirely on your machine without external API calls.

### Advantages

- No API costs
- Complete privacy
- No internet required
- Consistent performance
- No rate limits

### Disadvantages

- Initial download required
- Uses local compute resources
- Limited to available models
- May be slower than API

### Supported Local Models

#### Xenova/nomic-embed-text-v1 (Default)

**Dimensions**: 768  
**Size**: ~140MB  
**Quality**: Excellent  
**Speed**: Fast

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

Best general-purpose model. Recommended for most users.

#### Xenova/all-MiniLM-L6-v2

**Dimensions**: 384  
**Size**: ~23MB  
**Quality**: Good  
**Speed**: Very fast

```jsonc
{
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

Lightweight model for resource-constrained environments.

#### Xenova/all-mpnet-base-v2

**Dimensions**: 768  
**Size**: ~420MB  
**Quality**: Excellent  
**Speed**: Medium

```jsonc
{
  "embeddingModel": "Xenova/all-mpnet-base-v2"
}
```

High-quality model with strong semantic understanding.

#### Xenova/bge-small-en-v1.5

**Dimensions**: 384  
**Size**: ~130MB  
**Quality**: Very good  
**Speed**: Fast

```jsonc
{
  "embeddingModel": "Xenova/bge-small-en-v1.5"
}
```

Efficient model with good quality-to-size ratio.

#### Xenova/bge-base-en-v1.5

**Dimensions**: 768  
**Size**: ~420MB  
**Quality**: Excellent  
**Speed**: Medium

```jsonc
{
  "embeddingModel": "Xenova/bge-base-en-v1.5"
}
```

High-quality model optimized for retrieval tasks.

#### Xenova/bge-large-en-v1.5

**Dimensions**: 1024  
**Size**: ~1.2GB  
**Quality**: Outstanding  
**Speed**: Slow

```jsonc
{
  "embeddingModel": "Xenova/bge-large-en-v1.5"
}
```

Best quality but requires more resources.

### Model Selection Guide

**For Speed**:
- Xenova/all-MiniLM-L6-v2 (384 dimensions)
- Xenova/bge-small-en-v1.5 (384 dimensions)

**For Quality**:
- Xenova/bge-large-en-v1.5 (1024 dimensions)
- Xenova/all-mpnet-base-v2 (768 dimensions)

**For Balance**:
- Xenova/nomic-embed-text-v1 (768 dimensions, default)
- Xenova/bge-base-en-v1.5 (768 dimensions)

**For Low Memory**:
- Xenova/all-MiniLM-L6-v2 (384 dimensions, 23MB)

## API-Based Models

External API models use cloud services for embedding generation.

### Advantages

- No local compute required
- Access to latest models
- Consistent quality
- No model downloads

### Disadvantages

- API costs
- Requires internet
- Privacy considerations
- Rate limits
- Latency

### OpenAI Models

#### text-embedding-3-small

**Dimensions**: 1536  
**Cost**: $0.02 per 1M tokens  
**Quality**: Excellent

```jsonc
{
  "embeddingModel": "text-embedding-3-small",
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-..."
}
```

Best value for API-based embeddings.

#### text-embedding-3-large

**Dimensions**: 3072  
**Cost**: $0.13 per 1M tokens  
**Quality**: Outstanding

```jsonc
{
  "embeddingModel": "text-embedding-3-large",
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-..."
}
```

Highest quality OpenAI model.

#### text-embedding-ada-002 (Legacy)

**Dimensions**: 1536  
**Cost**: $0.10 per 1M tokens  
**Quality**: Very good

```jsonc
{
  "embeddingModel": "text-embedding-ada-002",
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-..."
}
```

Older model, use text-embedding-3-small instead.

### Other API Providers

#### Cohere

```jsonc
{
  "embeddingModel": "embed-english-v3.0",
  "embeddingApiUrl": "https://api.cohere.ai/v1",
  "embeddingApiKey": "..."
}
```

#### Voyage AI

```jsonc
{
  "embeddingModel": "voyage-2",
  "embeddingApiUrl": "https://api.voyageai.com/v1",
  "embeddingApiKey": "..."
}
```

## Configuration

### Local Model Configuration

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

Dimensions are auto-detected.

### API Model Configuration

```jsonc
{
  "embeddingModel": "text-embedding-3-small",
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-your-api-key-here"
}
```

Or use environment variable:

```bash
export OPENAI_API_KEY=sk-your-api-key-here
```

### Manual Dimensions

Override auto-detection:

```jsonc
{
  "embeddingModel": "custom-model",
  "embeddingDimensions": 768
}
```

## Changing Models

### Migration Required

When changing models with different dimensions, run migration:

```typescript
POST /api/migrate
{
  "newModel": "Xenova/all-MiniLM-L6-v2",
  "newDimensions": 384
}
```

### Migration Process

1. Backup database
2. Configure new model
3. Run migration
4. Wait for completion
5. Verify results

### Migration Time

Depends on database size:
- 1,000 memories: ~1 minute
- 10,000 memories: ~10 minutes
- 100,000 memories: ~1-2 hours

## Performance Comparison

### Speed (embeddings per second)

| Model | Speed | Dimensions |
|-------|-------|------------|
| Xenova/all-MiniLM-L6-v2 | 100+ | 384 |
| Xenova/nomic-embed-text-v1 | 50-80 | 768 |
| Xenova/bge-base-en-v1.5 | 40-60 | 768 |
| Xenova/bge-large-en-v1.5 | 20-30 | 1024 |
| OpenAI API | 1000+ | 1536 |

### Quality (retrieval accuracy)

| Model | Quality | Use Case |
|-------|---------|----------|
| Xenova/all-MiniLM-L6-v2 | Good | General use |
| Xenova/nomic-embed-text-v1 | Excellent | Recommended |
| Xenova/bge-base-en-v1.5 | Excellent | High quality |
| Xenova/bge-large-en-v1.5 | Outstanding | Best quality |
| OpenAI text-embedding-3-small | Excellent | API option |
| OpenAI text-embedding-3-large | Outstanding | Best API |

### Resource Usage

| Model | RAM | Disk | CPU |
|-------|-----|------|-----|
| Xenova/all-MiniLM-L6-v2 | 200MB | 23MB | Low |
| Xenova/nomic-embed-text-v1 | 500MB | 140MB | Medium |
| Xenova/bge-base-en-v1.5 | 1GB | 420MB | Medium |
| Xenova/bge-large-en-v1.5 | 2GB | 1.2GB | High |
| OpenAI API | Minimal | None | None |

## Cost Analysis

### Local Models

**One-time costs**:
- Download bandwidth
- Disk space

**Ongoing costs**:
- CPU/RAM usage
- Electricity

**Total**: Effectively free after initial download

### API Models

**OpenAI text-embedding-3-small**:
- $0.02 per 1M tokens
- Average memory: ~100 tokens
- 10,000 memories: ~$0.02
- 100,000 memories: ~$0.20

**OpenAI text-embedding-3-large**:
- $0.13 per 1M tokens
- 10,000 memories: ~$0.13
- 100,000 memories: ~$1.30

## Best Practices

### Model Selection

**Start with Default**:

Use Xenova/nomic-embed-text-v1 unless you have specific needs.

**Optimize for Use Case**:
- Speed priority: Xenova/all-MiniLM-L6-v2
- Quality priority: Xenova/bge-large-en-v1.5
- API option: text-embedding-3-small

### Migration Strategy

**Test First**:

Test new model on small dataset before full migration.

**Backup Always**:

Always backup database before migration.

**Monitor Quality**:

Compare search quality before and after migration.

### API Usage

**Use for Scale**:

API models better for very large databases (100k+ memories).

**Monitor Costs**:

Track API usage and costs regularly.

**Rate Limits**:

Be aware of provider rate limits.

## Troubleshooting

### Model Loading Failed

**Check model name**:

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

**Clear cache**:

```bash
rm -rf ~/.cache/huggingface
```

### API Errors

**Verify credentials**:

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer sk-..."
```

**Check endpoint**:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1"
}
```

### Dimension Mismatch

**Run migration**:

```typescript
POST /api/migrate
{
  "newModel": "Xenova/all-MiniLM-L6-v2",
  "newDimensions": 384
}
```

## Next Steps

- [Configuration Guide](Configuration-Guide) - All configuration options
- [Database Architecture](Database-Architecture) - Vector storage details
- [Performance Tuning](Performance-Tuning) - Optimization strategies
