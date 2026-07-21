const ALLOWED_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CORS_ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS = "Content-Type";

export interface CorsAllowOptions {
  /**
   * Whether HTTP Basic Auth is enforced by the web server. When true, the
   * CORS gate opens up beyond loopback origins — the auth challenge is what
   * actually protects memory data, so locking CORS down to loopback is
   * unnecessary once Basic Auth is on.
   */
  httpAuthEnabled?: boolean;
}

export function isAllowedBrowserOrigin(
  origin: string | null,
  options: CorsAllowOptions = {}
): boolean {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    if (ALLOWED_LOOPBACK_HOSTS.has(url.hostname)) return true;

    return options.httpAuthEnabled === true;
  } catch {
    return false;
  }
}

function corsHeaders(
  origin: string | null,
  options: CorsAllowOptions = {}
): Record<string, string> {
  if (!origin || !isAllowedBrowserOrigin(origin, options)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    Vary: "Origin",
  };
}

export function corsPreflightResponse(req: Request, options: CorsAllowOptions = {}): Response {
  const origin = req.headers.get("Origin");

  if (!isAllowedBrowserOrigin(origin, options)) {
    return disallowedCorsResponse();
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin, options),
      "Access-Control-Max-Age": "600",
    },
  });
}

export function disallowedCorsResponse(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "Cross-origin requests are restricted to loopback origins.",
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
