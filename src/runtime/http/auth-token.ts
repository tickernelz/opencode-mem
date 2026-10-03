import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { randomBytes } from "node:crypto";

const DATA_DIR = join(homedir(), ".opencode-mem");
const TOKEN_FILE = join(DATA_DIR, ".auth-token");
export const AUTH_HEADER = "x-opencode-mem-token";

let cachedToken: string | null = null;

/**
 * A shared secret generated on first run and persisted to a local,
 * user-only-readable file. Required on every /api/* request so that a
 * malicious web page (which cannot read cross-origin/opaque responses,
 * including the token injected into index.html) cannot drive the API via
 * CSRF even though the CORS check alone lets no-Origin requests through.
 */
export function getOrCreateAuthToken(): string {
  if (cachedToken) {
    return cachedToken;
  }

  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf-8").trim();
    if (existing) {
      cachedToken = existing;
      return cachedToken;
    }
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  if (platform() !== "win32") {
    try {
      chmodSync(TOKEN_FILE, 0o600);
    } catch {
      // best-effort; file was already created with mode 0o600 above
    }
  }
  cachedToken = token;
  return cachedToken;
}

export function isAuthorizedApiRequest(req: Request): boolean {
  const token = getOrCreateAuthToken();
  const provided = req.headers.get(AUTH_HEADER);
  return provided === token;
}
