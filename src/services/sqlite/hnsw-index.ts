import { mkdirSync, existsSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { log } from "../logger.js";
import { CONFIG } from "../../config.js";

let HNSWLib: any = null;

async function loadHNSWLib(): Promise<any> {
  if (!HNSWLib) {
    // hnswlib-wasm is compiled with Emscripten -sENVIRONMENT=web and requires
    // a browser-like global. This monkey-patch allows it to load in Node.js/Bun.
    if (typeof globalThis.window === "undefined") {
      (globalThis as any).window = globalThis;
    }
    const { loadHnswlib } = await import("hnswlib-wasm");
    HNSWLib = await loadHnswlib();
  }
  return HNSWLib;
}

export interface HNSWIndexData {
  id: string;
  vector: Float32Array;
}

export class HNSWIndex {
  private index: any = null;
  private idMap: Map<number, string> = new Map();
  private reverseMap: Map<string, number> = new Map();
  private nextId: number = 0;
  private dimensions: number;
  private indexPath: string;
  private maxElements: number = 50000;
  private initialized: boolean = false;

  constructor(dimensions: number, indexPath: string) {
    this.dimensions = dimensions;
    this.indexPath = indexPath;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const hnsw = await loadHNSWLib();

    const dir = dirname(this.indexPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // hnswlib-wasm uses Emscripten MEMFS (in-memory virtual FS) and has no
    // exported FS API for bridging to real filesystem. HNSW indexes are kept
    // purely in-memory and rebuilt from SQLite vectors on process restart.
    // Constructor requires 3 args: (spaceName, numDimensions, autoSaveFilename)
    this.index = new hnsw.HierarchicalNSW("cosine", this.dimensions, "index.hnsw");
    // initIndex requires 4 args: (maxElements, m, efConstruction, randomSeed)
    this.index.initIndex(this.maxElements, 16, 200, 100);

    this.initialized = true;
    log("HNSW index initialized (in-memory)", {
      path: this.indexPath,
      dimensions: this.dimensions,
    });
  }

  async insert(id: string, vector: Float32Array): Promise<void> {
    await this.ensureInitialized();

    if (this.reverseMap.has(id)) {
      const internalId = this.reverseMap.get(id)!;
      this.index!.markDelete(internalId);
    }

    const internalId = this.nextId++;
    // hnswlib-wasm addPoint requires 3 args: (point, label, replaceDeleted)
    this.index!.addPoint(vector, internalId, false);
    this.idMap.set(internalId, id);
    this.reverseMap.set(id, internalId);

    await this.save();
  }

  async insertBatch(items: HNSWIndexData[]): Promise<void> {
    await this.ensureInitialized();

    for (const item of items) {
      if (this.reverseMap.has(item.id)) {
        const internalId = this.reverseMap.get(item.id)!;
        this.index!.markDelete(internalId);
      }

      const internalId = this.nextId++;
      // hnswlib-wasm addPoint requires 3 args: (point, label, replaceDeleted)
      this.index!.addPoint(item.vector, internalId, false);
      this.idMap.set(internalId, item.id);
      this.reverseMap.set(item.id, internalId);
    }

    await this.save();
  }

  async search(queryVector: Float32Array, k: number): Promise<{ id: string; distance: number }[]> {
    await this.ensureInitialized();

    try {
      // hnswlib-wasm searchKnn requires 3 args: (queryPoint, numNeighbors, filter)
      const actualK = Math.min(k, this.reverseMap.size);
      if (actualK === 0) return [];
      const results = this.index!.searchKnn(queryVector, actualK, null);

      return results.neighbors
        .map((internalId: number, idx: number) => ({
          id: this.idMap.get(internalId) || "",
          distance: results.distances[idx] ?? 0,
        }))
        .filter((r: { id: string; distance: number }) => r.id);
    } catch (error) {
      log("HNSW search error", { error: String(error) });
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    await this.ensureInitialized();

    if (this.reverseMap.has(id)) {
      const internalId = this.reverseMap.get(id)!;
      this.index!.markDelete(internalId);
      this.idMap.delete(internalId);
      this.reverseMap.delete(id);
      await this.save();
    }
  }

  async save(): Promise<void> {
    if (!this.index) return;

    const dir = dirname(this.indexPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Only persist id mapping (.meta file). HNSW index data lives in-memory
    // and is rebuilt from SQLite vectors on process restart.
    const metaPath = this.indexPath + ".meta";
    const meta = {
      nextId: this.nextId,
      idMap: Object.fromEntries(this.idMap),
      reverseMap: Object.fromEntries(this.reverseMap),
    };
    writeFileSync(metaPath, JSON.stringify(meta));
  }

  getCount(): number {
    return this.reverseMap.size;
  }

  isPopulated(): boolean {
    return this.reverseMap.size > 0;
  }
}

export class HNSWIndexManager {
  private indexes: Map<string, HNSWIndex> = new Map();
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  getIndex(scope: string, scopeHash: string, shardIndex: number): HNSWIndex {
    const key = `${scope}_${scopeHash}_${shardIndex}`;

    if (!this.indexes.has(key)) {
      const indexPath = join(this.baseDir, scope + "s", `${key}.hnsw`);
      this.indexes.set(key, new HNSWIndex(CONFIG.embeddingDimensions, indexPath));
    }

    return this.indexes.get(key)!;
  }

  getTagsIndex(scope: string, scopeHash: string, shardIndex: number): HNSWIndex {
    const key = `${scope}_${scopeHash}_${shardIndex}_tags`;

    if (!this.indexes.has(key)) {
      const indexPath = join(this.baseDir, scope + "s", `${key}.hnsw`);
      this.indexes.set(key, new HNSWIndex(CONFIG.embeddingDimensions, indexPath));
    }

    return this.indexes.get(key)!;
  }

  async rebuildFromShard(
    db: any,
    scope: string,
    scopeHash: string,
    shardIndex: number
  ): Promise<void> {
    const contentIndex = this.getIndex(scope, scopeHash, shardIndex);
    const tagsIndex = this.getTagsIndex(scope, scopeHash, shardIndex);

    const rows = db.prepare("SELECT id, vector, tags_vector FROM memories").all() as any[];

    const contentItems: HNSWIndexData[] = [];
    const tagsItems: HNSWIndexData[] = [];

    for (const row of rows) {
      if (row.vector) {
        const vector = new Float32Array(row.vector.buffer);
        contentItems.push({ id: row.id, vector });
      }
      if (row.tags_vector) {
        const tagsVector = new Float32Array(row.tags_vector.buffer);
        tagsItems.push({ id: row.id, vector: tagsVector });
      }
    }

    if (contentItems.length > 0) {
      await contentIndex.insertBatch(contentItems);
    }
    if (tagsItems.length > 0) {
      await tagsIndex.insertBatch(tagsItems);
    }

    log("HNSW indexes rebuilt", {
      scope,
      scopeHash,
      shardIndex,
      content: contentItems.length,
      tags: tagsItems.length,
    });
  }

  async deleteIndex(scope: string, scopeHash: string, shardIndex: number): Promise<void> {
    const contentKey = `${scope}_${scopeHash}_${shardIndex}`;
    const tagsKey = `${scope}_${scopeHash}_${shardIndex}_tags`;

    this.indexes.delete(contentKey);
    this.indexes.delete(tagsKey);

    for (const key of [contentKey, tagsKey]) {
      const indexPath = join(this.baseDir, scope + "s", `${key}.hnsw`);
      const metaPath = indexPath + ".meta";

      try {
        if (existsSync(indexPath)) unlinkSync(indexPath);
        if (existsSync(metaPath)) unlinkSync(metaPath);
      } catch (error) {
        log("Error deleting HNSW index files", { path: indexPath, error: String(error) });
      }
    }
  }

  async cleanupOrphanedIndexes(validKeys: Set<string>): Promise<void> {
    const scopeDirs = ["users", "projects"];

    for (const scopeDir of scopeDirs) {
      const dir = join(this.baseDir, scopeDir);
      if (!existsSync(dir)) continue;

      const files = readdirSync(dir);
      for (const file of files) {
        if (file.endsWith(".hnsw")) {
          const key = basename(file, ".hnsw");
          if (!validKeys.has(key)) {
            const indexPath = join(dir, file);
            const metaPath = indexPath + ".meta";
            try {
              unlinkSync(indexPath);
              if (existsSync(metaPath)) unlinkSync(metaPath);
              log("Removed orphaned HNSW index", { path: indexPath });
            } catch (error) {
              log("Error removing orphaned index", { path: indexPath, error: String(error) });
            }
          }
        }
      }
    }
  }
}
