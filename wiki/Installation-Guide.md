# Installation Guide

This guide covers all installation methods for OpenCode Memory.

## Prerequisites

Before installing, ensure you have:

- **OpenCode**: Installed and configured
- **Git**: For source installation (optional)

## Installation Methods

### Method 1: Add to OpenCode Config (Recommended)

Add the plugin to your OpenCode configuration file:

**Location**: `~/.config/opencode/opencode.json` or `opencode.jsonc`

```jsonc
{
  "plugins": [
    "opencode-mem"
  ]
}
```

OpenCode will automatically download and install the plugin on next startup.

### Method 2: Install from Source

For development or contributing:

```bash
git clone https://github.com/tickernelz/opencode-mem.git
cd opencode-mem
bun install
bun run build
```

Then add the local path to your OpenCode config:

```jsonc
{
  "plugins": [
    "/path/to/opencode-mem"
  ]
}
```

## Post-Installation

### Verify Installation

Check that the plugin is recognized by OpenCode:

```bash
opencode plugins list
```

You should see `opencode-mem` in the output.

### First Run

On first run, OpenCode Memory will:

1. Create configuration directory: `~/.config/opencode/`
2. Generate default config: `opencode-mem.jsonc`
3. Create data directory: `~/.opencode-mem/data/`
4. Initialize SQLite database
5. Start web server on port 4747

### Access Web Interface

Open your browser to:

```
http://127.0.0.1:4747
```

You should see the OpenCode Memory web interface.

## Configuration

The default configuration file is created at:

```
~/.config/opencode/opencode-mem.jsonc
```

### Minimal Configuration

The plugin works with zero configuration, but you can customize:

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "webServerPort": 4747,
  "embeddingModel": "Xenova/nomic-embed-text-v1"
}
```

### Enable Auto-Capture

To enable automatic memory capture, add API credentials:

```jsonc
{
  "autoCaptureEnabled": true,
  "memoryModel": "gpt-4",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-your-api-key-here"
}
```

See [Configuration Guide](Configuration-Guide) for all options.

## Directory Structure

After installation, you will have:

```
~/.config/opencode/
└── opencode-mem.jsonc          # Configuration file

~/.opencode-mem/
└── data/
    ├── memories_shard_0.db     # SQLite database
    └── memories_shard_0.db-wal # Write-ahead log
```

## Updating

### Update Plugin

OpenCode automatically updates plugins. To force an update, restart OpenCode or use:

```bash
opencode plugins update
```

### Update from Source

If installed from source:

```bash
cd opencode-mem
git pull origin main
bun install
bun run build
```

## Uninstallation

### Remove Plugin

Remove from OpenCode configuration:

**Edit**: `~/.config/opencode/opencode.json` or `opencode.jsonc`

```jsonc
{
  "plugins": [
    // Remove "opencode-mem" from this array
  ]
}
```

### Remove Data (Optional)

To completely remove all data:

```bash
rm -rf ~/.opencode-mem
rm ~/.config/opencode/opencode-mem.jsonc
```

**Warning**: This will delete all stored memories permanently.

## Troubleshooting Installation

### Port Already in Use

If port 4747 is already in use, change it in the config:

```jsonc
{
  "webServerPort": 4748
}
```

### Permission Errors

If you encounter permission errors:

```bash
sudo chown -R $USER:$USER ~/.opencode-mem
sudo chown -R $USER:$USER ~/.config/opencode
```

### Build Errors

If building from source fails:

1. Clear node_modules: `rm -rf node_modules`
2. Clear cache: `bun pm cache rm`
3. Reinstall: `bun install`
4. Rebuild: `bun run build`

Or with npm:

1. Clear node_modules: `rm -rf node_modules`
2. Clear cache: `npm cache clean --force`
3. Reinstall: `npm install`
4. Rebuild: `npm run build`

### SQLite Errors

If SQLite initialization fails:

1. Check disk space: `df -h`
2. Check permissions: `ls -la ~/.opencode-mem`
3. Remove corrupted database: `rm ~/.opencode-mem/data/*.db`
4. Restart OpenCode

## Next Steps

- [Quick Start](Quick-Start) - Learn basic usage
- [Configuration Guide](Configuration-Guide) - Customize settings
- [Memory Operations](Memory-Operations) - Use the memory tool
