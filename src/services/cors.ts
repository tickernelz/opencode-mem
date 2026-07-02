const ALLOWED_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CORS_ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS = "Content-Type";

export function isAllowedBrowserOrigin(origin: string | null): boolean {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ALLOWED_LOOPBACK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !isAllowedBrowserOrigin(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    Vary: "Origin",
  };
}

export function corsPreflightResponse(req: Request): Response {
  const origin = req.headers.get("Origin");

  if (!isAllowedBrowserOrigin(origin)) {
    return disallowedCorsResponse();
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
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
