# Performance Tuning

Optimization strategies for OpenCode Memory performance, resource usage, and cost efficiency.

## Performance Metrics

Key metrics to monitor:
- Search latency
- Memory usage (RAM)
- Database size
- API costs (if using external services)
- Auto-capture frequency

## Search Performance

### Reduce Search Latency

**Lower Memory Limits**:

```jsonc
{
  "maxMemories": 3,
  "maxProjectMemories": 5
}
```

Fewer results = faster search.

**Increase Similarity Threshold**:

```jsonc
{
  "similarityThreshold": 0.7
}
```

Higher threshold filters more results, reducing processing.

**Use Smaller Embedding Model**:

```jsonc
{
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

384 dimensions vs 768 = 2x faster.

**Optimize Shard Size**:

```jsonc
{
  "maxVectorsPerShard": 25000
}
```

Smaller shards = faster individual queries.

### Benchmark Results

**Search Time by Model** (10,000 memories):

| Model | Dimensions | Time |
|-------|------------|------|
| Xenova/all-MiniLM-L6-v2 | 384 | 15ms |
| Xenova/nomic-embed-text-v1 | 768 | 28ms |
| Xenova/bge-base-en-v1.5 | 768 | 30ms |
| Xenova/bge-large-en-v1.5 | 1024 | 45ms |

**Search Time by Database Size** (768 dimensions):

| Memories | Time |
|----------|------|
| 1,000 | 8ms |
| 10,000 | 28ms |
| 50,000 | 85ms |
| 100,000 | 160ms |

## Memory Usage (RAM)

### Reduce RAM Consumption

**Use Smaller Embedding Model**:

```jsonc
{
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

RAM usage: 200MB vs 500MB+ for larger models.

**Enable Auto-Cleanup**:

```jsonc
{
  "autoCleanupEnabled": true,
  "autoCleanupRetentionDays": 14
}
```

Keeps database small.

**Reduce Shard Size**:

```jsonc
{
  "maxVectorsPerShard": 25000
}
```

Smaller shards use less memory per query.

**Disable Web Server** (if not needed):

```jsonc
{
  "webServerEnabled": false
}
```

Saves ~50MB RAM.

### RAM Usage by Component

| Component | RAM Usage |
|-----------|-----------|
| Base plugin | 50MB |
| Embedding model (small) | 200MB |
| Embedding model (medium) | 500MB |
| Embedding model (large) | 2GB |
| Web server | 50MB |
| Database cache | 100MB |

## Database Size

### Reduce Disk Usage

**Run Cleanup Regularly**:

```bash
curl -X POST http://127.0.0.1:4747/api/cleanup \
  -H "Content-Type: application/json" \
  -d '{"retentionDays":30,"dryRun":false}'
```

**Run Deduplication**:

```bash
curl -X POST http://127.0.0.1:4747/api/deduplicate \
  -H "Content-Type: application/json" \
  -d '{"similarityThreshold":0.9,"dryRun":false}'
```

**Vacuum Database**:

```bash
sqlite3 ~/.opencode-mem/data/memories_shard_0.db "VACUUM;"
```

Reclaims deleted space.

**Use Smaller Dimensions**:

```jsonc
{
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "embeddingDimensions": 384
}
```

384 dimensions = 50% smaller than 768.

### Database Size Estimates

**Per Memory** (average):
- Content: 200 bytes
- Metadata: 100 bytes
- Vector (384d): 1.5 KB
- Vector (768d): 3 KB
- Vector (1024d): 4 KB

**Total Database Size**:

| Memories | 384d | 768d | 1024d |
|----------|------|------|-------|
| 1,000 | 2 MB | 3 MB | 4 MB |
| 10,000 | 18 MB | 32 MB | 42 MB |
| 50,000 | 88 MB | 156 MB | 208 MB |
| 100,000 | 175 MB | 310 MB | 415 MB |

## API Cost Optimization

### Reduce Embedding API Costs

**Use Local Models**:

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

Zero API costs.

**Switch to Cheaper API Model**:

```jsonc
{
  "embeddingModel": "text-embedding-3-small",
  "embeddingApiUrl": "https://api.openai.com/v1"
}
```

$0.02 per 1M tokens vs $0.13 for large model.

### Reduce Auto-Capture Costs

**Increase Token Threshold**:

```jsonc
{
  "autoCaptureTokenThreshold": 20000
}
```

Halves capture frequency.

**Use Cheaper Model**:

```jsonc
{
  "memoryModel": "gpt-3.5-turbo"
}
```

90% cost reduction vs GPT-4.

**Reduce Context Window**:

```jsonc
{
  "autoCaptureContextWindow": 2
}
```

Fewer tokens per capture.

**Limit Max Memories**:

```jsonc
{
  "autoCaptureMaxMemories": 5
}
```

Shorter responses = lower cost.

### Cost Estimates

**Embedding Costs** (OpenAI text-embedding-3-small):

| Memories | Cost |
|----------|------|
| 1,000 | $0.002 |
| 10,000 | $0.02 |
| 100,000 | $0.20 |

**Auto-Capture Costs** (GPT-4, 10k threshold):

| Daily Tokens | Captures/Day | Monthly Cost |
|--------------|--------------|--------------|
| 50,000 | 5 | $4.50 |
| 100,000 | 10 | $9.00 |
| 200,000 | 20 | $18.00 |

**Auto-Capture Costs** (GPT-3.5-Turbo, 10k threshold):

| Daily Tokens | Captures/Day | Monthly Cost |
|--------------|--------------|--------------|
| 50,000 | 5 | $0.45 |
| 100,000 | 10 | $0.90 |
| 200,000 | 20 | $1.80 |

## Configuration Profiles

### Speed-Optimized

```jsonc
{
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "similarityThreshold": 0.7,
  "maxMemories": 3,
  "maxProjectMemories": 5,
  "maxVectorsPerShard": 25000
}
```

**Characteristics**:
- Fast search (10-15ms)
- Low RAM (250MB)
- Good quality

### Quality-Optimized

```jsonc
{
  "embeddingModel": "Xenova/bge-large-en-v1.5",
  "similarityThreshold": 0.5,
  "maxMemories": 10,
  "maxProjectMemories": 20,
  "maxVectorsPerShard": 50000
}
```

**Characteristics**:
- Best search quality
- Higher RAM (2GB+)
- Slower search (40-50ms)

### Balanced

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "similarityThreshold": 0.6,
  "maxMemories": 5,
  "maxProjectMemories": 10,
  "maxVectorsPerShard": 50000
}
```

**Characteristics**:
- Good balance
- Moderate RAM (500MB)
- Moderate speed (25-30ms)

### Low-Resource

```jsonc
{
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "similarityThreshold": 0.7,
  "maxMemories": 3,
  "maxProjectMemories": 5,
  "maxVectorsPerShard": 25000,
  "autoCleanupEnabled": true,
  "autoCleanupRetentionDays": 14,
  "deduplicationEnabled": true
}
```

**Characteristics**:
- Minimal RAM (250MB)
- Small database
- Fast search
- Automatic cleanup

### Cost-Optimized

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "autoCaptureEnabled": true,
  "memoryModel": "gpt-3.5-turbo",
  "autoCaptureTokenThreshold": 20000,
  "autoCaptureContextWindow": 2,
  "autoCaptureMaxMemories": 5
}
```

**Characteristics**:
- Zero embedding costs (local)
- Low auto-capture costs
- Good quality

## Monitoring

### Check Performance

**Search Latency**:

```bash
time curl -X POST http://127.0.0.1:4747/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'
```

**Database Size**:

```bash
du -sh ~/.opencode-mem/data/
```

**Memory Usage**:

```bash
ps aux | grep opencode
```

### Statistics Dashboard

Access web interface statistics:

```
http://127.0.0.1:4747
```

Click "Statistics" tab for:
- Memory counts
- Database size
- Search performance
- Auto-capture stats

## Benchmarking

### Run Benchmark

Create test script:

```bash
#!/bin/bash
for i in {1..100}; do
  curl -s -X POST http://127.0.0.1:4747/api/search \
    -H "Content-Type: application/json" \
    -d '{"query":"test query"}' > /dev/null
done
```

Measure average time:

```bash
time ./benchmark.sh
```

### Compare Configurations

1. Benchmark with current config
2. Change configuration
3. Restart OpenCode
4. Benchmark again
5. Compare results

## Best Practices

### Regular Maintenance

**Weekly**:
- Check database size
- Review statistics

**Monthly**:
- Run cleanup
- Run deduplication
- Vacuum database

**Quarterly**:
- Review configuration
- Benchmark performance
- Consider model upgrade

### Optimization Strategy

1. **Measure Current Performance**
2. **Identify Bottleneck** (search, RAM, disk, cost)
3. **Apply Targeted Optimization**
4. **Measure Again**
5. **Iterate**

### Avoid Over-Optimization

Don't optimize prematurely:
- Default config works well for most users
- Only optimize if experiencing issues
- Balance performance vs quality vs cost

## Next Steps

- [Configuration Guide](Configuration-Guide) - All configuration options
- [Embedding Models](Embedding-Models) - Model selection guide
- [Troubleshooting](Troubleshooting) - Common issues
