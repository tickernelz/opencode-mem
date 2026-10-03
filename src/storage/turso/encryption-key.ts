import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { CONFIG } from "../../config.js";
import { log } from "../../infra/logger.js";
import { resolveSecretValue } from "../../infra/secret-resolver.js";

export const DEFAULT_DATABASE_ENCRYPTION_KEY_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "opencode-mem-db.key"
);

const HEX_KEY_RE = /^[0-9a-fA-F]+$/;

export function isValidDatabaseEncryptionHexKey(value: string): boolean {
  const trimmed = value.trim();
  return HEX_KEY_RE.test(trimmed) && (trimmed.length === 32 || trimmed.length === 64);
}

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

function encryptionMarkerPath(): string {
  return join(CONFIG.storagePath, ".tursodb-encrypted-v1");
}

/**
 * Create a new AES-256 key (32 random bytes as 64 hex chars) at path with mode 0600.
 * Refuses to create a new key when encrypted DBs already exist (fail-closed).
 */
export function generateDatabaseEncryptionKeyFile(
  keyPath: string = DEFAULT_DATABASE_ENCRYPTION_KEY_PATH
): string {
  const resolved = expandPath(keyPath);
  if (existsSync(encryptionMarkerPath())) {
    throw new Error(
      `Cannot generate a new database encryption key at ${resolved}: ` +
        `encrypted databases already exist under ${CONFIG.storagePath}. ` +
        `Restore the original key file or decrypt/migrate with the old key first.`
    );
  }

  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const hexkey = randomBytes(32).toString("hex");
  writeFileSync(resolved, `${hexkey}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  if (platform() !== "win32") {
    try {
      chmodSync(resolved, 0o600);
    } catch {
      // best-effort; mode was set on write where supported
    }
  }

  log("Generated database encryption key", { path: resolved });
  return hexkey;
}

/**
 * Ensure a key file exists (generate once if missing), then return its hex contents.
 */
export function ensureDatabaseEncryptionKeyFile(
  keyPath: string = DEFAULT_DATABASE_ENCRYPTION_KEY_PATH
): string {
  const resolved = expandPath(keyPath);
  if (!existsSync(resolved)) {
    return generateDatabaseEncryptionKeyFile(resolved);
  }

  const content = readFileSync(resolved, "utf-8").trim();
  if (!isValidDatabaseEncryptionHexKey(content)) {
    throw new Error(
      `Database encryption key file ${resolved} is invalid. ` +
        `Expected a 32- or 64-character hex string (AES-128 or AES-256).`
    );
  }

  if (platform() !== "win32") {
    try {
      chmodSync(resolved, 0o600);
    } catch {
      // ignore chmod failures on exotic filesystems
    }
  }

  return content;
}

/**
 * Resolve the active encryption hex key, auto-generating the default key file when
 * encryption is enabled and no key is configured yet.
 */
export function resolveOrCreateDatabaseEncryptionKey(): string | null {
  const enabled = CONFIG.databaseEncryptionEnabled === true;
  const raw = CONFIG.databaseEncryptionKey?.trim();

  if (!enabled && !raw) {
    return null;
  }

  // Explicit hex in config (discouraged, but supported).
  if (raw && isValidDatabaseEncryptionHexKey(raw) && !raw.includes("://")) {
    return raw.trim();
  }

  if (raw?.startsWith("env://")) {
    const value = resolveSecretValue(raw)?.trim();
    if (!value || !isValidDatabaseEncryptionHexKey(value)) {
      throw new Error(
        `databaseEncryptionKey ${raw} must resolve to a 32- or 64-character hex string`
      );
    }
    return value;
  }

  if (raw?.startsWith("file://")) {
    const filePath = expandPath(raw.slice(7));
    return ensureDatabaseEncryptionKeyFile(filePath);
  }

  if (raw) {
    // Treat bare paths as file paths for convenience.
    if (raw.includes("/") || raw.startsWith("~")) {
      return ensureDatabaseEncryptionKeyFile(raw);
    }
    throw new Error(
      "databaseEncryptionKey must be env://VAR, file://path, or a 32/64-char hex string"
    );
  }

  // Enabled without explicit key → default file, auto-create once.
  return ensureDatabaseEncryptionKeyFile(DEFAULT_DATABASE_ENCRYPTION_KEY_PATH);
}
