/**
 * Child-process worker for short-write simulation in the cold-buffer tests.
 * Pair with profile-cold-buffer-worker-preload.ts via `bun --preload`.
 *
 * The preload patch only limits how many bytes a single low-level
 * fs.writeSync call forwards — the production saveColdBuffers() path, the
 * real tmp+rename flow and the real fd bookkeeping all stay live.
 *
 * Args: dir profileId description preExisting(""=none)
 * Env/argv: SWMODE=short-ascii|short-utf8|zero|half (read by the preload)
 * Prints one JSON line: { ok, error, targetBytes, tmpLeft }
 */
import * as fs from "node:fs";
import { join } from "node:path";

// Drop non-positional flags (SWMODE=... is consumed by the preload).
const args = process.argv.slice(2).filter((a) => !a.startsWith("SWMODE="));
const dir = args[0]!;
const profileId = args[1]!;
const description = args[2]!;
const preExisting = args[3]!;

const coldBufferPath = join(dir, "cold-buffer.json");
if (preExisting === "") {
  try {
    fs.unlinkSync(coldBufferPath);
  } catch {
    // no file yet
  }
} else {
  fs.writeFileSync(coldBufferPath, preExisting, "utf-8");
}

const { CONFIG } = await import("../../src/config.js");
CONFIG.storagePath = dir;
CONFIG.userProfileEmbeddingMinDescriptionLength = 5;
delete CONFIG.opencodeProvider;
delete CONFIG.opencodeModel;
delete CONFIG.memoryModel;
delete CONFIG.memoryApiUrl;

const { UserProfileManager } = await import("../../src/user-profile/user-profile-manager.js");
const coldEmbed = { isWarmedUp: false } as any;

const mgr = new UserProfileManager();
let ok = true;
let error: string | null = null;
try {
  await mgr.mergeProfileData(
    { preferences: [], patterns: [], workflows: [] },
    { preferences: [{ category: "style", description }] },
    coldEmbed,
    profileId
  );
} catch (e) {
  ok = false;
  error = String(e);
}

let targetBytes: string | null;
try {
  targetBytes = fs.readFileSync(coldBufferPath, "utf-8");
} catch {
  targetBytes = null;
}
const tmpLeft = fs.readdirSync(dir).filter((f) => f.includes(".tmp")).length;

console.log(JSON.stringify({ ok, error, targetBytes, tmpLeft }));
