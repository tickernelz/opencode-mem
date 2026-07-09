import type {
  BackendInsertItem,
  BackendSearchResult,
  VectorBackend,
  VectorBackendSearchParams,
  VectorKind,
} from "./types.js";
import type { ShardInfo } from "../sqlite/types.js";
import { cosineSimilarity } from "../../utils/math.js";

interface RankedRow {
  id: string;
  vector: Float32Array;
}

interface VectorRow {
  id: string;
  vector?: Uint8Array | ArrayBuffer | null;
  tags_vector?: Uint8Array | ArrayBuffer | null;
}

export class ExactScanBackend implements VectorBackend {
  getBackendName(): string {
    return "exact-scan";
  }

  rankVectors(rows: RankedRow[], queryVector: Float32Array, limit: number): BackendSearchResult[] {
    return rows
      .map((row) => ({
        id: row.id,
        distance: 1 - cosineSimilarity(row.vector, queryVector),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  async insert(_args: {
    id: string;
    vector: Float32Array;
    shard: ShardInfo;
    kind: VectorKind;
  }): Promise<void> {}

  async insertBatch(_args: {
    items: BackendInsertItem[];
    shard: ShardInfo;
    kind: VectorKind;
  }): Promise<void> {}

  async delete(_args: { id: string; shard: ShardInfo; kind: VectorKind }): Promise<void> {}

  async search(args: VectorBackendSearchParams): Promise<BackendSearchResult[]> {
    const column = args.kind === "tags" ? "tags_vector" : "vector";
    const rows = (
      args.db as {
        prepare: (sql: string) => { all: () => VectorRow[] };
      }
    )
      .prepare(`SELECT id, ${column} FROM memories WHERE ${column} IS NOT NULL`)
      .all();

    if (rows.length === 0) {
      return [];
    }

    const rankedRows: RankedRow[] = rows
      .map((row) => ({
        id: row.id,
        vector: this.decodeVector(args.kind === "tags" ? row.tags_vector : row.vector),
      }))
      .filter((row) => row.vector.length > 0);

    return this.rankVectors(rankedRows, args.queryVector, args.limit);
  }

  async rebuildFromShard(_args: {
    db: unknown;
    shard: ShardInfo;
    kind: VectorKind;
  }): Promise<void> {}

  async deleteShardIndexes(_args: { shard: ShardInfo }): Promise<void> {}

  private decodeVector(value: Uint8Array | ArrayBuffer | null | undefined): Float32Array {
    if (!value) {
      return new Float32Array();
    }

    if (value instanceof Uint8Array) {
      return new Float32Array(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      );
    }

    return new Float32Array(value);
  }
}
