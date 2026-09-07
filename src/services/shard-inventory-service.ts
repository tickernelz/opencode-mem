import { basename, join, normalize, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { CONFIG } from "../config.js";
import { assertSafeScopeHash, isValidScopeHash } from "./memory-scope.js";
import { getProjectTagInfo } from "./tags.js";
import { ensureTursoReady } from "./turso/ready.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import type { ShardInfo } from "./turso/types.js";

export type ShardInventoryStatus =
  "current" | "linked" | "orphaned" | "missing-file" | "empty" | "ambiguous";

export interface ProjectShardDescriptor {
  shardId: number | null;
  shardIndex: number;
  dbPath: string;
  fileName: string;
  isActive: boolean;
  vectorCount: number;
  memoryCount: number;
  fileExists: boolean;
}

export interface ProjectShardGroup {
  scope: "project";
  scopeHash: string;
  shardIndices: number[];
  shards: ProjectShardDescriptor[];
  memoryCount: number;
  containerTag: string | null;
  projectPath: string | null;
  projectPathCandidates: Array<{ path: string; count: number }>;
  projectName: string | null;
  gitRepoUrl: string | null;
  pathExists: boolean;
  status: ShardInventoryStatus;
  matchesCurrentProject: boolean;
}

export interface ListShardsResult {
  success: true;
  storagePath: string;
  currentProject: {
    tag: string;
    scopeHash: string;
    projectPath: string;
  };
  shards: ProjectShardGroup[];
  summary: {
    total: number;
    current: number;
    linked: number;
    orphaned: number;
    missingFile: number;
    empty: number;
    ambiguous: number;
  };
}

export interface ResolveMigrationSourceOptions {
  fromPath?: string;
  fromHash?: string;
}

export interface ResolvedMigrationSource {
  scopeHash: string;
  matchedBy: "fromHash" | "storedProjectPath" | "liveProjectIdentity";
  group: ProjectShardGroup;
}

export interface ResolveMigrationSourceResult {
  success: boolean;
  source?: ResolvedMigrationSource;
  candidates?: ProjectShardGroup[];
  error?: string;
}

const SHARD_FILENAME_RE = /^(user|project)_([a-f0-9]{16})_shard_(\d+)\.db$/;

export function normalizeProjectPath(path: string): string {
  const normalized = normalize(resolve(path)).replace(/\\/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.replace(/\/+$/, "");
  }
  return normalized;
}

function listProjectShardDbPaths(): string[] {
  const dir = join(CONFIG.storagePath, "projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".db") && !file.includes(".bak") && !file.includes(".tmp"))
    .map((file) => join(dir, file));
}

async function inspectShardContent(dbPath: string): Promise<{
  memoryCount: number;
  pathCandidates: Array<{ path: string; count: number; containerTag: string | null }>;
  projectName: string | null;
  gitRepoUrl: string | null;
  containerTag: string | null;
}> {
  if (!existsSync(dbPath)) {
    return {
      memoryCount: 0,
      pathCandidates: [],
      projectName: null,
      gitRepoUrl: null,
      containerTag: null,
    };
  }

  const db = await tursoConnectionManager.getConnection(dbPath);
  const memoryCount = await tursoVectorSearch.countAllVectors(db);
  const pathCounts = await tursoVectorSearch.getProjectPathCounts(db);
  const tags = await tursoVectorSearch.getDistinctTags(db);
  const first = tags[0];

  // Collapse path+tag rows into path totals while keeping a representative tag.
  const byPath = new Map<string, { path: string; count: number; containerTag: string | null }>();
  for (const row of pathCounts) {
    const key = normalizeProjectPath(row.projectPath);
    const existing = byPath.get(key);
    if (existing) {
      existing.count += row.count;
      if (!existing.containerTag && row.containerTag) {
        existing.containerTag = row.containerTag;
      }
    } else {
      byPath.set(key, {
        path: key,
        count: row.count,
        containerTag: row.containerTag,
      });
    }
  }

  const pathCandidates = [...byPath.values()].sort(
    (a, b) => b.count - a.count || a.path.localeCompare(b.path)
  );

  return {
    memoryCount,
    pathCandidates,
    projectName: first?.project_name ? String(first.project_name) : null,
    gitRepoUrl: first?.git_repo_url ? String(first.git_repo_url) : null,
    containerTag:
      pathCandidates[0]?.containerTag ??
      (first?.container_tag ? String(first.container_tag) : null),
  };
}

function deriveStatus(input: {
  matchesCurrentProject: boolean;
  memoryCount: number;
  pathExists: boolean;
  projectPath: string | null;
  pathCandidates: Array<{ path: string; count: number }>;
  anyFileMissing: boolean;
  allFilesMissing: boolean;
}): ShardInventoryStatus {
  if (input.pathCandidates.length > 1) {
    return "ambiguous";
  }
  if (input.allFilesMissing) {
    return "missing-file";
  }
  if (input.memoryCount === 0) {
    return "empty";
  }
  if (input.matchesCurrentProject) {
    return "current";
  }
  if (input.projectPath && !input.pathExists) {
    return "orphaned";
  }
  if (input.projectPath && input.pathExists) {
    return "linked";
  }
  if (input.anyFileMissing) {
    return "missing-file";
  }
  return "orphaned";
}

export class ShardInventoryService {
  async listShards(currentDirectory: string): Promise<ListShardsResult> {
    await ensureTursoReady();

    const current = getProjectTagInfo(currentDirectory);
    const currentHash = current.tag.split("_").pop()!;
    assertSafeScopeHash(currentHash);

    const registered = await tursoShardManager.getAllShards("project", "");
    const byHash = new Map<
      string,
      {
        registered: ShardInfo[];
        filePaths: Set<string>;
      }
    >();

    for (const shard of registered) {
      const entry = byHash.get(shard.scopeHash) ?? { registered: [], filePaths: new Set() };
      entry.registered.push(shard);
      entry.filePaths.add(shard.dbPath);
      byHash.set(shard.scopeHash, entry);
    }

    for (const path of listProjectShardDbPaths()) {
      const match = SHARD_FILENAME_RE.exec(basename(path));
      if (!match || match[1] !== "project") continue;
      const scopeHash = match[2]!;
      const entry = byHash.get(scopeHash) ?? { registered: [], filePaths: new Set() };
      entry.filePaths.add(path);
      byHash.set(scopeHash, entry);
    }

    const groups: ProjectShardGroup[] = [];

    for (const [scopeHash, entry] of byHash) {
      const shardIndexes = new Set<number>();
      for (const shard of entry.registered) {
        shardIndexes.add(shard.shardIndex);
      }
      for (const path of entry.filePaths) {
        const match = SHARD_FILENAME_RE.exec(basename(path));
        if (match) shardIndexes.add(Number(match[3]));
      }

      const descriptors: ProjectShardDescriptor[] = [];
      let memoryCount = 0;
      const pathCountMap = new Map<string, number>();
      let projectName: string | null = null;
      let gitRepoUrl: string | null = null;
      let containerTag: string | null = null;

      for (const shardIndex of [...shardIndexes].sort((a, b) => a - b)) {
        const registeredShard =
          entry.registered.find((shard) => shard.shardIndex === shardIndex) ?? null;
        const dbPath =
          registeredShard?.dbPath ??
          tursoShardManager.getShardPath("project", scopeHash, shardIndex);
        const fileExists = existsSync(dbPath);
        const content = await inspectShardContent(dbPath);
        memoryCount += content.memoryCount;

        for (const candidate of content.pathCandidates) {
          pathCountMap.set(
            candidate.path,
            (pathCountMap.get(candidate.path) ?? 0) + candidate.count
          );
          if (!containerTag && candidate.containerTag) {
            containerTag = candidate.containerTag;
          }
        }
        if (!projectName && content.projectName) projectName = content.projectName;
        if (!gitRepoUrl && content.gitRepoUrl) gitRepoUrl = content.gitRepoUrl;
        if (!containerTag && content.containerTag) containerTag = content.containerTag;

        descriptors.push({
          shardId: registeredShard?.id ?? null,
          shardIndex,
          dbPath,
          fileName: basename(dbPath),
          isActive: registeredShard?.isActive ?? shardIndex === Math.max(...shardIndexes),
          vectorCount: registeredShard?.vectorCount ?? content.memoryCount,
          memoryCount: content.memoryCount,
          fileExists,
        });
      }

      const projectPathCandidates = [...pathCountMap.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
      const projectPath = projectPathCandidates[0]?.path ?? null;
      const pathExists = projectPath ? existsSync(projectPath) : false;
      const matchesCurrentProject = scopeHash === currentHash;
      const anyFileMissing = descriptors.some((shard) => !shard.fileExists);
      const allFilesMissing =
        descriptors.length > 0 && descriptors.every((shard) => !shard.fileExists);

      groups.push({
        scope: "project",
        scopeHash,
        shardIndices: descriptors.map((shard) => shard.shardIndex),
        shards: descriptors,
        memoryCount,
        containerTag: containerTag ?? `${CONFIG.containerTagPrefix}_project_${scopeHash}`,
        projectPath,
        projectPathCandidates,
        projectName,
        gitRepoUrl,
        pathExists,
        status: deriveStatus({
          matchesCurrentProject,
          memoryCount,
          pathExists,
          projectPath,
          pathCandidates: projectPathCandidates,
          anyFileMissing,
          allFilesMissing,
        }),
        matchesCurrentProject,
      });
    }

    groups.sort((a, b) => {
      if (a.matchesCurrentProject !== b.matchesCurrentProject) {
        return a.matchesCurrentProject ? -1 : 1;
      }
      return b.memoryCount - a.memoryCount || a.scopeHash.localeCompare(b.scopeHash);
    });

    const summary = {
      total: groups.length,
      current: groups.filter((g) => g.status === "current").length,
      linked: groups.filter((g) => g.status === "linked").length,
      orphaned: groups.filter((g) => g.status === "orphaned").length,
      missingFile: groups.filter((g) => g.status === "missing-file").length,
      empty: groups.filter((g) => g.status === "empty").length,
      ambiguous: groups.filter((g) => g.status === "ambiguous").length,
    };

    return {
      success: true,
      storagePath: CONFIG.storagePath,
      currentProject: {
        tag: current.tag,
        scopeHash: currentHash,
        projectPath: current.projectPath || getProjectTagInfo(currentDirectory).displayName,
      },
      shards: groups,
      summary,
    };
  }

  async resolveMigrationSource(
    currentDirectory: string,
    options: ResolveMigrationSourceOptions
  ): Promise<ResolveMigrationSourceResult> {
    const inventory = await this.listShards(currentDirectory);
    const { fromHash, fromPath } = options;

    if (fromHash) {
      if (!isValidScopeHash(fromHash)) {
        return {
          success: false,
          error: `Invalid fromHash: expected 16 lowercase hex characters, got "${fromHash}"`,
        };
      }
      const group = inventory.shards.find((shard) => shard.scopeHash === fromHash);
      if (!group) {
        return {
          success: false,
          error: `No project shards found for hash ${fromHash}. Run memory list-shards to inspect available shards.`,
        };
      }
      if (group.memoryCount === 0) {
        return {
          success: false,
          error: `Shard hash ${fromHash} exists but contains no memories.`,
        };
      }
      return {
        success: true,
        source: {
          scopeHash: fromHash,
          matchedBy: "fromHash",
          group,
        },
      };
    }

    if (!fromPath || !fromPath.trim()) {
      return {
        success: false,
        error: "fromPath or fromHash is required for migrate",
      };
    }

    const normalizedFrom = normalizeProjectPath(fromPath);
    const pathMatches = inventory.shards.filter((group) =>
      group.projectPathCandidates.some((candidate) => candidate.path === normalizedFrom)
    );

    if (pathMatches.length === 1) {
      const group = pathMatches[0]!;
      if (group.memoryCount === 0) {
        return {
          success: false,
          error: `Matched project path ${normalizedFrom} but the shard contains no memories.`,
        };
      }
      return {
        success: true,
        source: {
          scopeHash: group.scopeHash,
          matchedBy: "storedProjectPath",
          group,
        },
      };
    }

    if (pathMatches.length > 1) {
      return {
        success: false,
        error: `Ambiguous fromPath match for ${normalizedFrom}. Use fromHash with memory list-shards to select one shard.`,
        candidates: pathMatches,
      };
    }

    // If the old directory still exists, resolve its live project identity.
    if (existsSync(normalizedFrom)) {
      try {
        const live = getProjectTagInfo(normalizedFrom);
        const liveHash = live.tag.split("_").pop()!;
        const group = inventory.shards.find((shard) => shard.scopeHash === liveHash);
        if (group && group.memoryCount > 0) {
          return {
            success: true,
            source: {
              scopeHash: liveHash,
              matchedBy: "liveProjectIdentity",
              group,
            },
          };
        }
      } catch {
        // Fall through to the generic missing-source error.
      }
    }

    return {
      success: false,
      error:
        `No shard found for fromPath ${normalizedFrom}. ` +
        `If the old directory no longer exists, run memory list-shards and migrate with fromHash.`,
    };
  }
}

export const shardInventoryService = new ShardInventoryService();
