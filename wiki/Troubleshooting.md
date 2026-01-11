# Troubleshooting

Common issues and solutions for OpenCode Memory.

## Installation Issues

### Port Already in Use

**Problem**: Web server fails to start because port 4747 is in use.

**Solution**: Change port in configuration:

```jsonc
{
  "webServerPort": 4748
}
```

**Verify**: Check if port is available:

```bash
lsof -i :4747
```

### Permission Errors

**Problem**: Cannot create database or configuration files.

**Solution**: Fix permissions:

```bash
sudo chown -R $USER:$USER ~/.opencode-mem
sudo chown -R $USER:$USER ~/.config/opencode
```

### Build Errors

**Problem**: TypeScript compilation fails.

**Solution**:

With Bun:

```bash
rm -rf node_modules
bun pm cache rm
bun install
bun run build
```

Or with npm:

```bash
rm -rf node_modules
npm cache clean --force
npm install
npm run build
```

### SQLite Initialization Failed

**Problem**: Database cannot be created or opened.

**Solution**:

1. Check disk space: `df -h`
2. Check permissions: `ls -la ~/.opencode-mem`
3. Remove corrupted database: `rm ~/.opencode-mem/data/*.db`
4. Restart OpenCode

## Web Interface Issues

### Interface Not Accessible

**Problem**: Cannot access web interface at configured URL.

**Solution**:

1. Verify server is running:

```bash
curl http://127.0.0.1:4747/api/stats
```

2. Check configuration:

```jsonc
{
  "webServerEnabled": true,
  "webServerPort": 4747,
  "webServerHost": "127.0.0.1"
}
```

3. Check firewall settings
4. Restart OpenCode

### Slow Loading

**Problem**: Web interface loads slowly or times out.

**Solution**:

1. Reduce result limit in settings
2. Run cleanup to reduce database size
3. Run deduplication
4. Increase similarity threshold
5. Use smaller embedding model

### Search Not Working

**Problem**: Search returns no results or errors.

**Solution**:

1. Verify embedding model is loaded
2. Check database exists: `ls ~/.opencode-mem/data/`
3. Lower similarity threshold
4. Restart OpenCode

## Memory Operations Issues

### Cannot Add Memory

**Problem**: Memory tool returns error when adding memory.

**Solution**:

1. Verify required parameters:

```typescript
memory({
  mode: "add",
  content: "Your content here",
  scope: "user"
})
```

2. Check content is not empty
3. Verify scope is "user" or "project"
4. Check database is writable

### Search Returns No Results

**Problem**: Search query returns empty results.

**Solution**:

1. Lower similarity threshold:

```jsonc
{
  "similarityThreshold": 0.5
}
```

2. Verify memories exist:

```typescript
memory({ mode: "list", scope: "user" })
```

3. Check embedding model is working
4. Try different search query

### Memory Not Found

**Problem**: Cannot find memory by ID.

**Solution**:

1. Verify memory ID is correct
2. List memories to get valid IDs:

```typescript
memory({ mode: "list", scope: "user" })
```

3. Check memory wasn't deleted
4. Verify database integrity

## Auto-Capture Issues

### Auto-Capture Not Working

**Problem**: Automatic memory capture is not triggering.

**Solution**:

1. Verify configuration:

```jsonc
{
  "autoCaptureEnabled": true,
  "memoryModel": "gpt-4",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-..."
}
```

2. Check API key is valid:

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer sk-your-api-key"
```

3. Verify token threshold is reached:

```typescript
memory({ mode: "auto-capture-stats" })
```

4. Check OpenCode logs for errors

### No Memories Extracted

**Problem**: Auto-capture runs but extracts no memories.

**Solution**:

1. Increase context window:

```jsonc
{
  "autoCaptureContextWindow": 5
}
```

2. Lower token threshold:

```jsonc
{
  "autoCaptureTokenThreshold": 5000
}
```

3. Ensure conversation has extractable content
4. Try different AI model

### High API Costs

**Problem**: Auto-capture is expensive.

**Solution**:

1. Switch to cheaper model:

```jsonc
{
  "memoryModel": "gpt-3.5-turbo"
}
```

2. Increase threshold:

```jsonc
{
  "autoCaptureTokenThreshold": 20000
}
```

3. Reduce context window:

```jsonc
{
  "autoCaptureContextWindow": 2
}
```

4. Limit max memories:

```jsonc
{
  "autoCaptureMaxMemories": 5
}
```

## Performance Issues

### Slow Search

**Problem**: Search takes too long to complete.

**Solution**:

1. Reduce max memories:

```jsonc
{
  "maxMemories": 3,
  "maxProjectMemories": 5
}
```

2. Increase similarity threshold:

```jsonc
{
  "similarityThreshold": 0.7
}
```

3. Run deduplication
4. Use smaller embedding model:

```jsonc
{
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

### High Memory Usage

**Problem**: OpenCode Memory uses too much RAM.

**Solution**:

1. Enable auto-cleanup:

```jsonc
{
  "autoCleanupEnabled": true,
  "autoCleanupRetentionDays": 14
}
```

2. Reduce shard size:

```jsonc
{
  "maxVectorsPerShard": 25000
}
```

3. Use smaller embedding model
4. Run manual cleanup

### Large Database Size

**Problem**: Database files are very large.

**Solution**:

1. Run cleanup:

```typescript
POST /api/cleanup
{ "retentionDays": 30, "dryRun": false }
```

2. Run deduplication:

```typescript
POST /api/deduplicate
{ "similarityThreshold": 0.9, "dryRun": false }
```

3. Vacuum database:

```bash
sqlite3 ~/.opencode-mem/data/memories_shard_0.db "VACUUM;"
```

## Embedding Issues

### Model Loading Failed

**Problem**: Embedding model fails to load.

**Solution**:

1. Verify model name is correct:

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

2. Check internet connection (first download)
3. Clear model cache: `rm -rf ~/.cache/huggingface`
4. Try different model

### API Embedding Errors

**Problem**: External embedding API returns errors.

**Solution**:

1. Verify API credentials:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "sk-..."
}
```

2. Check API endpoint is correct
3. Verify API key has permissions
4. Check rate limits
5. Test API manually:

```bash
curl https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"input": "test", "model": "text-embedding-3-small"}'
```

### Dimension Mismatch

**Problem**: Vector dimension mismatch errors.

**Solution**:

Run migration to new dimensions:

```typescript
POST /api/migrate
{
  "newModel": "Xenova/all-MiniLM-L6-v2",
  "newDimensions": 384
}
```

## Database Issues

### Database Locked

**Problem**: SQLite database is locked.

**Solution**:

1. Close all connections
2. Restart OpenCode
3. Check for zombie processes:

```bash
ps aux | grep opencode
```

4. Remove lock file:

```bash
rm ~/.opencode-mem/data/*.db-shm
rm ~/.opencode-mem/data/*.db-wal
```

### Corrupted Database

**Problem**: Database file is corrupted.

**Solution**:

1. Backup database:

```bash
cp -r ~/.opencode-mem/data ~/.opencode-mem/data.backup
```

2. Try recovery:

```bash
sqlite3 ~/.opencode-mem/data/memories_shard_0.db ".recover" | \
  sqlite3 ~/.opencode-mem/data/memories_shard_0_recovered.db
```

3. If recovery fails, delete and start fresh:

```bash
rm ~/.opencode-mem/data/*.db
```

### Shard Creation Failed

**Problem**: Cannot create new shard.

**Solution**:

1. Check disk space: `df -h`
2. Check permissions: `ls -la ~/.opencode-mem/data`
3. Verify shard size setting:

```jsonc
{
  "maxVectorsPerShard": 50000
}
```

## Configuration Issues

### Config Not Loading

**Problem**: Configuration changes not taking effect.

**Solution**:

1. Verify config file location:

```bash
cat ~/.config/opencode/opencode-mem.jsonc
```

2. Check JSON syntax (JSONC allows comments)
3. Restart OpenCode
4. Check logs for validation errors

### Invalid Configuration

**Problem**: Configuration validation errors.

**Solution**:

1. Check required fields are present
2. Verify value types (string, number, boolean)
3. Ensure thresholds are 0.0-1.0
4. Validate port numbers (1024-65535)
5. Check file paths exist

### Environment Variables Not Working

**Problem**: Environment variables not recognized.

**Solution**:

1. Export variables before starting OpenCode:

```bash
export OPENAI_API_KEY=sk-...
opencode
```

2. Add to shell profile:

```bash
echo 'export OPENAI_API_KEY=sk-...' >> ~/.bashrc
source ~/.bashrc
```

3. Verify variable is set:

```bash
echo $OPENAI_API_KEY
```

## Maintenance Issues

### Cleanup Not Working

**Problem**: Cleanup operation fails or does nothing.

**Solution**:

1. Run in dry run mode first:

```typescript
POST /api/cleanup
{ "retentionDays": 30, "dryRun": true }
```

2. Check retention days setting
3. Verify memories are old enough
4. Check pinned memories (excluded from cleanup)

### Deduplication Errors

**Problem**: Deduplication fails or removes wrong memories.

**Solution**:

1. Use dry run mode:

```typescript
POST /api/deduplicate
{ "similarityThreshold": 0.9, "dryRun": true }
```

2. Adjust similarity threshold
3. Review duplicate groups before deleting
4. Backup database first

### Migration Stuck

**Problem**: Migration process hangs or fails.

**Solution**:

1. Check logs for errors
2. Verify new model is valid
3. Ensure sufficient disk space
4. Restart migration with smaller batch size
5. If stuck, restart OpenCode

## Logging and Debugging

### Enable Debug Logging

Add to configuration:

```jsonc
{
  "logLevel": "debug"
}
```

### Check Logs

OpenCode logs location varies by platform:

**Linux**:
```bash
tail -f ~/.opencode/logs/opencode.log
```

**macOS**:
```bash
tail -f ~/Library/Logs/OpenCode/opencode.log
```

**Windows**:
```
%APPDATA%\OpenCode\logs\opencode.log
```

### Test API Endpoints

Test REST API manually:

```bash
curl http://127.0.0.1:4747/api/stats
curl http://127.0.0.1:4747/api/memories?scope=user
```

## Getting Help

If issues persist:

1. Check [GitHub Issues](https://github.com/tickernelz/opencode-mem/issues)
2. Search for similar problems
3. Open new issue with:
   - OpenCode version
   - OpenCode Memory version
   - Operating system
   - Configuration (redact API keys)
   - Error messages
   - Steps to reproduce

## Next Steps

- [Configuration Guide](Configuration-Guide) - Detailed configuration
- [Performance Tuning](Performance-Tuning) - Optimization strategies
- [API Reference](API-Reference) - REST API documentation
