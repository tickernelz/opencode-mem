# Web Interface

Complete guide to the OpenCode Memory web interface for visual memory management.

## Accessing the Interface

Default URL: `http://127.0.0.1:4747`

Custom port (if configured):

```jsonc
{
  "webServerPort": 4748
}
```

Then access: `http://127.0.0.1:4748`

## Interface Overview

The web interface provides:

- Memory browser with search and filters
- Memory editor for inline editing
- Bulk operations for multiple memories
- Maintenance tools (cleanup, deduplication, migration)
- Statistics dashboard
- Real-time updates

## Main Features

### Memory Browser

**View All Memories**:
- Paginated list of all memories
- Sort by date, relevance, or pinned status
- Filter by scope, type, or tags
- Search by keyword or similarity

**Memory Cards**:

Each memory displays:
- Content preview
- Scope badge (user/project)
- Type label
- Creation date
- Pin status
- Action buttons (edit, delete, pin)

### Search

**Text Search**:

Enter keywords to search memory content:

```
authentication JWT
```

Searches for memories containing "authentication" or "JWT".

**Vector Search**:

Use natural language queries:

```
How does authentication work in this project?
```

Returns semantically similar memories.

**Search Options**:
- Scope filter (all, user, project)
- Similarity threshold slider
- Result limit

### Filters

**By Scope**:
- All memories
- User scope only
- Project scope only

**By Type**:
- All types
- Specific type (preference, architecture, etc.)

**By Tags**:
- Filter by custom tags
- Multiple tag selection

**By Status**:
- All memories
- Pinned only
- Unpinned only

### Memory Editor

**Edit Memory**:

1. Click memory card
2. Edit modal opens
3. Modify content, scope, type, or tags
4. Click "Save" to update

**Editable Fields**:
- Content (text area)
- Scope (dropdown)
- Type (text input)
- Tags (comma-separated)
- Pinned status (checkbox)

**Validation**:
- Content cannot be empty
- Scope must be user or project
- Changes saved immediately

### Bulk Operations

**Select Multiple Memories**:

1. Click checkbox on memory cards
2. Select multiple memories
3. Choose bulk action

**Available Actions**:
- Delete selected
- Export selected (JSON)
- Change scope
- Add tags

**Select All**:

Click "Select All" to select all visible memories.

### Pin Memories

**Pin Important Memories**:

Click pin icon on memory card to mark as important.

**Pinned Behavior**:
- Appear at top of list
- Highlighted with pin icon
- Excluded from auto-cleanup
- Higher priority in search

**Unpin**:

Click pin icon again to unpin.

### Delete Memories

**Delete Single Memory**:

Click delete icon on memory card.

**Delete Multiple**:

1. Select memories using checkboxes
2. Click "Delete Selected"
3. Confirm deletion

**Confirmation**:

Deletion requires confirmation to prevent accidents.

## Maintenance Tools

### Cleanup

Remove old memories based on retention period.

**Access**: Click "Maintenance" tab, then "Cleanup"

**Options**:
- Retention days (default: 30)
- Dry run mode (preview without deleting)
- Exclude pinned memories

**Process**:

1. Set retention days
2. Enable dry run (optional)
3. Click "Run Cleanup"
4. Review results
5. Run again without dry run to delete

**Results**:
- Total memories scanned
- Memories to delete
- Memories deleted (if not dry run)
- Excluded memories (pinned)

### Deduplication

Find and remove similar duplicate memories.

**Access**: Click "Maintenance" tab, then "Deduplication"

**Options**:
- Similarity threshold (default: 0.9)
- Dry run mode
- Keep newest/oldest

**Process**:

1. Set similarity threshold
2. Enable dry run (optional)
3. Click "Run Deduplication"
4. Review duplicate groups
5. Run again without dry run to delete

**Results**:
- Duplicate groups found
- Memories to delete
- Memories deleted (if not dry run)
- Space saved

**Threshold Guide**:
- 0.95+: Very conservative, only exact duplicates
- 0.90: Default, similar duplicates
- 0.85: Aggressive, may remove related memories

### Migration

Change embedding model dimensions.

**Access**: Click "Maintenance" tab, then "Migration"

**When to Use**:
- Switching embedding models
- Changing vector dimensions
- Upgrading to better model

**Options**:
- New model name
- New dimensions
- Batch size

**Process**:

1. Select new model
2. Enter new dimensions
3. Click "Start Migration"
4. Monitor progress
5. Wait for completion

**Progress**:
- Total memories
- Processed memories
- Percentage complete
- Estimated time remaining

**Warning**: Migration can take time for large databases.

## Statistics Dashboard

**Access**: Click "Statistics" tab

**Metrics Displayed**:

**Memory Counts**:
- Total memories
- User scope memories
- Project scope memories
- Pinned memories

**Storage**:
- Database size
- Number of shards
- Average memory size

**Auto-Capture**:
- Total captures
- Memories created
- Last capture time

**Search Performance**:
- Average search time
- Total searches
- Cache hit rate

## Settings

**Access**: Click "Settings" tab

**Configurable Options**:

**Display**:
- Memories per page
- Sort order
- Theme (light/dark)

**Search**:
- Default similarity threshold
- Default result limit
- Search mode (text/vector)

**Auto-Refresh**:
- Enable/disable
- Refresh interval

**Export/Import**:
- Export all memories (JSON)
- Import memories from file

## Keyboard Shortcuts

**Navigation**:
- `Ctrl+F` or `/`: Focus search
- `Esc`: Close modal
- `Ctrl+A`: Select all

**Actions**:
- `Delete`: Delete selected
- `Ctrl+E`: Edit selected (single)
- `Ctrl+P`: Pin/unpin selected

**Pagination**:
- `←`: Previous page
- `→`: Next page

## Mobile Support

The interface is responsive and works on mobile devices:

- Touch-friendly buttons
- Swipe gestures
- Optimized layout
- Mobile search

## API Integration

The web interface uses REST API endpoints:

**GET /api/memories**:
- List memories with filters

**POST /api/memories**:
- Create new memory

**PUT /api/memories/:id**:
- Update memory

**DELETE /api/memories/:id**:
- Delete memory

**POST /api/search**:
- Vector search

**GET /api/stats**:
- Statistics

**POST /api/cleanup**:
- Run cleanup

**POST /api/deduplicate**:
- Run deduplication

**POST /api/migrate**:
- Run migration

See [API Reference](API-Reference) for details.

## Troubleshooting

### Interface Not Loading

**Check Server Status**:

```bash
curl http://127.0.0.1:4747/api/stats
```

**Verify Configuration**:

```jsonc
{
  "webServerEnabled": true,
  "webServerPort": 4747
}
```

**Check Logs**:

Look for errors in OpenCode logs.

### Slow Performance

**Reduce Result Limit**:

Lower the number of memories displayed per page.

**Increase Similarity Threshold**:

Filter out less relevant results.

**Run Cleanup**:

Remove old memories to reduce database size.

**Run Deduplication**:

Remove duplicate memories.

### Search Not Working

**Check Embedding Model**:

Ensure embedding model is loaded:

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

**Verify Database**:

Check database file exists:

```bash
ls -la ~/.opencode-mem/data/
```

**Restart Server**:

Restart OpenCode to reload configuration.

## Best Practices

### Organization

**Use Tags**:

Add tags to memories for better organization:

```
react, frontend, component
```

**Pin Important**:

Pin critical memories to keep them accessible.

**Regular Cleanup**:

Run cleanup monthly to remove outdated memories.

### Search

**Use Filters**:

Combine search with filters for precise results.

**Adjust Threshold**:

Lower threshold for broader results, higher for precision.

**Save Searches**:

Bookmark common searches in browser.

### Maintenance

**Dry Run First**:

Always use dry run mode before actual cleanup or deduplication.

**Backup Before Migration**:

Export memories before running migration.

**Monitor Statistics**:

Check statistics regularly to track growth.

## Next Steps

- [Memory Operations](Memory-Operations) - Use the memory tool
- [API Reference](API-Reference) - REST API documentation
- [Troubleshooting](Troubleshooting) - Common issues
