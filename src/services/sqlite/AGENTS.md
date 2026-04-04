# SQLite service agent guide

## Scope

- `src/services/sqlite/` owns SQLite bootstrapping, connection reuse, shard metadata, shard creation/rotation, and vector-search orchestration over shard databases.

## Where to look

- `sqlite-bootstrap.ts` — lazy `require("bun:sqlite")` loader.
- `connection-manager.ts` — connection cache, PRAGMA setup, and inline schema migration.
- `shard-manager.ts` — `metadata.db`, active shard lookup, shard validation, shard creation, shard rotation.
- `vector-search.ts` — bridge from memory operations to shard DB rows and vector backend operations.
- `types.ts` — shared shard/search/storage types.

## Conventions

- Keep the lazy `require("bun:sqlite")` bootstrap pattern. This repo intentionally avoids a top-level eager import.
- All database opens should go through `connectionManager`; do not instantiate raw SQLite connections in random services.
- Connection setup PRAGMAs (`busy_timeout`, `WAL`, `synchronous`, `cache_size`, `temp_store`, `foreign_keys`) are centralized in `connection-manager.ts`.
- Schema evolution currently happens inside `ConnectionManager.migrateSchema()`. If you add a column, extend that path instead of inventing a second migration mechanism.
- Shard metadata lives in `metadata.db`; per-scope memories live in separate shard DBs under `${CONFIG.storagePath}/users` or `${CONFIG.storagePath}/projects`.

## Gotchas

- `ShardManager` writes `embedding_dimensions` and `embedding_model` into each shard's `shard_metadata`; other migration logic depends on that.
- Reaching `CONFIG.maxVectorsPerShard` marks the current shard read-only and creates the next shard automatically.
- Invalid or missing shard DBs are recreated and metadata rows can be deleted/reinserted; preserve that self-healing behavior.
- `src/services/migration-service.ts` lives outside this folder but is tightly coupled to shard layout and embedding metadata.

## Do not

- Do not bypass shard selection when writing memory data.
- Do not move PRAGMA setup into call sites.
- Do not treat `metadata.db` as just another shard; it is the registry for all shard files.
