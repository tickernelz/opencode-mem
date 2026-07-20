import { runLegacyTursoMigration } from "./legacy-migrator.js";
import { tursoShardManager } from "./shard-manager.js";
import { log } from "../logger.js";

let initPromise: Promise<void> | null = null;
let isReady = false;

export async function ensureTursoReady(): Promise<void> {
  if (isReady) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await runLegacyTursoMigration();
      await tursoShardManager.getAllShards("user", "");
      isReady = true;
    } catch (error) {
      initPromise = null;
      log("Turso ready gate failed", { error: String(error) });
      throw error;
    }
  })();

  return initPromise;
}

export function resetTursoReady(): void {
  isReady = false;
  initPromise = null;
}
