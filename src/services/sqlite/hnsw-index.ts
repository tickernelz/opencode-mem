import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { log } from "../logger.js";
import { CONFIG } from "../../config.js";

let HNSWLib: any = null;

async function loadHNSWLib(): Promise<any> {
  if (!HNSWLib) {
    const module = await import("hnswlib-wasm");
    HNSWLib = module;
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

    if (existsSync(this.indexPath)) {
      try {
        this.index = new hnsw.HierarchicalNSW("cosine", this.dimensions);
        this.index.readIndex(this.indexPath);

        const metaPath = this.indexPath + ".meta";
        if (existsSync(metaPath)) {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          this.nextId = meta.nextId || 0;
          this.idMap = new Map(
            Object.entries(meta.idMap || {}).map(([k, v]) => [Number(k), v as string])
          );
          this.reverseMap = new Map(Object.entries(meta.reverseMap || {}) as [string, number][]);
        }

        log("HNSW index loaded", { path: this.indexPath, count: this.nextId });
      } catch (error) {
        log("Failed to load HNSW index, creating new", {
          path: this.indexPath,
          error: String(error),
        });
        this.index = new hnsw.HierarchicalNSW("cosine", this.dimensions, this.maxElements);
      }
    } else {
      this.index = new hnsw.HierarchicalNSW("cosine", this.dimensions, this.maxElements);
      log("HNSW index created", { path: this.indexPath, dimensions: this.dimensions });
    }

    this.initialized = true;
  }

  async insert(id: string, vector: Float32Array): Promise<void> {
    await this.ensureInitialized();

    if (this.reverseMap.has(id)) {
      const internalId = this.reverseMap.get(id)!;
      this.index.markDelete(internalId);
    }

    const internalId = this.nextId++;
    this.index.addPoint(vector, internalId);
    this.idMap.set(internalId, id);
    this.reverseMap.set(id, internalId);

    await this.save();
  }

  async insertBatch(items: HNSWIndexData[]): Promise<void> {
    await this.ensureInitialized();

    for (const item of items) {
      if (this.reverseMap.has(item.id)) {
        const internalId = this.reverseMap.get(item.id)!;
        this.index.markDelete(internalId);
      }

      const internalId = this.nextId++;
      this.index.addPoint(item.vector, internalId);
      this.idMap.set(internalId, item.id);
      this.reverseMap.set(item.id, internalId);
    }

    await this.save();
  }

  async search(queryVector: Float32Array, k: number): Promise<{ id: string; distance: number }[]> {
    await this.ensureInitialized();

    try {
      const results = this.index.searchKnn(queryVector, k);

      return results.neighbors
        .map((internalId: number, idx: number) => ({
          id: this.idMap.get(internalId) || "",
          distance: results.distances[idx],
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
      this.index.markDelete(internalId);
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

    this.index.writeIndex(this.indexPath);

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

  async rebuildFromShard(
    db: any,
    scope: string,
    scopeHash: string,
    shardIndex: number
  ): Promise<void> {
    const index = this.getIndex(scope, scopeHash, shardIndex);

    const rows = db.prepare("SELECT id, vector FROM memories").all() as any[];

    const items: HNSWIndexData[] = [];
    for (const row of rows) {
      if (row.vector) {
        const vector = new Float32Array(row.vector.buffer);
        items.push({ id: row.id, vector });
      }
    }

    if (items.length > 0) {
      await index.insertBatch(items);
      log("HNSW index rebuilt", { scope, scopeHash, shardIndex, count: items.length });
    }
  }

  async deleteIndex(scope: string, scopeHash: string, shardIndex: number): Promise<void> {
    const key = `${scope}_${scopeHash}_${shardIndex}`;
    this.indexes.delete(key);

    const indexPath = join(this.baseDir, scope + "s", `${key}.hnsw`);
    const metaPath = indexPath + ".meta";

    try {
      if (existsSync(indexPath)) unlinkSync(indexPath);
      if (existsSync(metaPath)) unlinkSync(metaPath);
    } catch (error) {
      log("Error deleting HNSW index files", { path: indexPath, error: String(error) });
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
