const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function assertWebServerNetworkAuth(
  host: string,
  apiToken?: string,
  basicAuthEnabled = false
): void {
  if (!isLoopbackHost(host) && !apiToken && !basicAuthEnabled) {
    throw new Error(
      `webServerHost "${host}" exposes the API on the network. Set webServerApiToken in opencode-mem.jsonc, or bind to 127.0.0.1.`
    );
  }
}

export function authorizeApiRequest(req: Request, apiToken?: string): Response | null {
  if (!apiToken) return null;

  const header = req.headers.get("authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const alt = req.headers.get("x-opencode-mem-token")?.trim();
  const token = bearer || alt;

  if (token && token === apiToken) {
    return null;
  }

  return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
