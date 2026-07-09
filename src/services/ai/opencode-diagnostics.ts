export interface FetchEndpoint {
  readonly label: string;
  readonly url: string;
}

export function diagnosticUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

export function responseStatus(res: Response): string {
  const statusTextByCode: Record<number, string> = {
    500: "Internal Server Error",
    502: "Bad Gateway",
  };
  return `${res.status} ${res.statusText || statusTextByCode[res.status] || "Unknown Status"}`;
}

function redactedBody(text: string): string {
  return text ? "<redacted response body>" : "<empty body>";
}

export async function readJson<T>(res: Response, endpoint: FetchEndpoint): Promise<T> {
  const text = await res.text();
  const url = diagnosticUrl(endpoint.url);
  if (!res.ok) {
    throw new Error(
      `opencode-mem: opencode ${endpoint.label} failed at ${url} (${responseStatus(res)}): ${redactedBody(text)}`
    );
  }
  if (!text) {
    throw new Error(
      `opencode-mem: opencode ${endpoint.label} at ${url} returned an empty response body`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `opencode-mem: opencode ${endpoint.label} at ${url} returned non-JSON body: ${redactedBody(text)}`
    );
  }
}
