import { timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";

export const WEB_AUTH_REALM = "OpenCode Memory Explorer";

export interface WebAuthOptions {
  /**
   * Plain-text password used for HTTP Basic Auth. Empty / undefined disables
   * auth entirely (the previous default). The caller is responsible for
   * resolving `env://` / `file://` shortcuts via the shared
   * `resolveSecretValue` helper before passing the value in.
   */
  password?: string;
  /**
   * Plain-text username. Defaults to `os.userInfo().username` so that, when
   * the server is bound to a LAN-reachable interface, the obvious choice
   * is the OS account that launched opencode.
   */
  username?: string;
}

export interface WebAuthConfig {
  enabled: boolean;
  username: string;
}

export interface AuthCheckResult {
  ok: boolean;
  response?: Response;
}

export class WebAuth {
  private readonly enabled: boolean;
  private readonly username: string;
  private readonly expectedUsername: Buffer;
  private readonly expectedPassword: Buffer;

  constructor(options: WebAuthOptions = {}) {
    const password = (options.password ?? "").trim();
    this.enabled = password.length > 0;
    const explicitUsername = (options.username ?? "").trim();
    this.username = explicitUsername || safeOsUsername();
    this.expectedUsername = Buffer.from(this.username, "utf8");
    this.expectedPassword = Buffer.from(password, "utf8");
  }

  getConfig(): WebAuthConfig {
    return { enabled: this.enabled, username: this.username };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Validate the HTTP Basic Auth credentials on the incoming request.
   *
   * Returns `{ ok: true }` when auth is disabled, when the request is for a
   * path the user-facing browser must reach without credentials (the health
   * probe), or when the supplied `Authorization: Basic …` header matches the
   * configured username/password.
   *
   * Otherwise returns a fully-formed 401 Response carrying the
   * `WWW-Authenticate` challenge so browsers pop their native login dialog.
   */
  check(req: Request, path: string): AuthCheckResult {
    if (!this.enabled) return { ok: true };

    if (path === "/api/health") return { ok: true };

    const header = req.headers.get("Authorization");
    if (header) {
      const decoded = decodeBasicAuth(header);
      if (
        decoded &&
        constantTimeEquals(decoded.username, this.expectedUsername) &&
        constantTimeEquals(decoded.password, this.expectedPassword)
      ) {
        return { ok: true };
      }
    }

    return { ok: false, response: this.challenge() };
  }

  challenge(): Response {
    return new Response("Authentication required", {
      status: 401,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": `Basic realm="${WEB_AUTH_REALM}", charset="UTF-8"`,
        "Cache-Control": "no-store",
      },
    });
  }
}

function safeOsUsername(): string {
  try {
    const info = userInfo();
    if (info.username && info.username.length > 0) return info.username;
  } catch {
    // userInfo can throw on some sandboxes; fall through to env fallbacks.
  }
  if (process.env.USER && process.env.USER.length > 0) return process.env.USER;
  if (process.env.USERNAME && process.env.USERNAME.length > 0) return process.env.USERNAME;
  return "user";
}

function constantTimeEquals(provided: string, expected: Buffer): boolean {
  const providedBuf = Buffer.from(provided ?? "", "utf8");
  if (providedBuf.length !== expected.length) {
    // Run a dummy compare so the call duration stays independent of length.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(providedBuf, expected);
}

function decodeBasicAuth(header: string): { username: string; password: string } | null {
  if (!header.toLowerCase().startsWith("basic ")) return null;
  const encoded = header.slice(6).trim();
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return {
    username: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
  };
}
