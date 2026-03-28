import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { generateText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createMinimax, createMinimaxOpenAI } from "vercel-minimax-ai-provider";
import type { ZodType } from "zod";

type OAuthAuth = { type: "oauth"; refresh: string; access: string; expires: number };
type ApiAuth = { type: "api"; key: string };
type Auth = OAuthAuth | ApiAuth;

// --- State (set from plugin init in index.ts, Task 4) ---
let _statePath: string | null = null;
let _connectedProviders: string[] = [];

export function setStatePath(path: string): void {
  _statePath = path;
}

export function getStatePath(): string {
  if (!_statePath) {
    throw new Error("opencode state path not initialized. Plugin may not be fully started.");
  }
  return _statePath;
}

// Provider name aliases mapping
const PROVIDER_ALIASES: Record<string, string> = {
  "MiniMax Coding Plan (minimaxi.com)": "minimax-cn-coding-plan",
  "MiniMax (minimaxi.com)": "minimax",
  "MiniMax Coding Plan (minimax.io)": "minimax-coding-plan",
};
// Reverse mapping: internal name -> opencode display name
const ALIASES_REVERSE: Record<string, string> = {
  "minimax-cn-coding-plan": "MiniMax Coding Plan (minimaxi.com)",
  "minimax": "MiniMax (minimaxi.com)",
  "minimax-coding-plan": "MiniMax Coding Plan (minimax.io)",
};

export function setConnectedProviders(providers: string[]): void {
  let validProviders: string[] = [];
  if (Array.isArray(providers)) {
    validProviders = providers.filter(p => typeof p === "string");
  } else if (typeof providers === "string") {
    try {
      const parsed = JSON.parse(providers);
      validProviders = Array.isArray(parsed) ? parsed.filter(p => typeof p === "string") : [];
    } catch {
      validProviders = [];
    }
  }
  _connectedProviders = validProviders;
}

export function isProviderConnected(providerName: string): boolean {
  if (providerName.includes("minimax") || providerName.includes("MiniMax")) {
    const homeDir = os.homedir();
    const authPath = join(homeDir, ".local", "share", "opencode", "auth.json");
    try {
      if (existsSync(authPath)) {
        const authContent = readFileSync(authPath, "utf-8");
        const auth = JSON.parse(authContent);
        const keys = Object.keys(auth);
        const hasMinimax = keys.some(k => k.toLowerCase().includes("minimax"));
        return hasMinimax;
      }
    } catch {}
  }
  if (_connectedProviders.includes(providerName)) {
    return true;
  }
  for (const connected of _connectedProviders) {
    if (PROVIDER_ALIASES[connected] === providerName) {
      return true;
    }
  }
  const reverseMatch = ALIASES_REVERSE[providerName];
  if (reverseMatch && _connectedProviders.includes(reverseMatch)) {
    return true;
  }
  return false;
}

// --- Auth ---
function findAuthJsonPath(statePath: string): string | undefined {
  const homeDir = os.homedir();
  const candidates = [
    join(statePath, "auth.json"),
    join(dirname(dirname(statePath)), "share", "opencode", "auth.json"),
    join(statePath.replace("/state/", "/share/"), "auth.json"),
    join(statePath.replace("\\state\\", "\\share\\"), "auth.json"),
    // 全局 auth.json 路径 (Linux/macOS: ~/.local/share/opencode/auth.json, Windows: %USERPROFILE%/.local/share/opencode/auth.json)
    join(homeDir, ".local", "share", "opencode", "auth.json"),
    // Windows 可能的全局路径
    join(homeDir, ".config", "opencode", "auth.json"),
  ];
  return candidates.find(existsSync);
}

export function readOpencodeAuth(statePath: string, providerName: string): Auth {
  const authPath = findAuthJsonPath(statePath);
  let raw: string | undefined;
  if (authPath) {
    try {
      raw = readFileSync(authPath, "utf-8");
    } catch {}
  }
  if (!raw || !authPath) {
    throw new Error(
      `opencode auth.json not found at ${authPath ?? statePath}. Is opencode authenticated?`
    );
  }
  let parsed: Record<string, Auth>;
  try {
    parsed = JSON.parse(raw) as Record<string, Auth>;
  } catch {
    throw new Error(`Failed to read opencode auth.json: invalid JSON`);
  }
  let auth = parsed[providerName];
  if (!auth) {
    const reverseKey = ALIASES_REVERSE[providerName];
    if (reverseKey) {
      auth = parsed[reverseKey];
    }
  }
  if (!auth) {
    for (const [authKey, internalName] of Object.entries(PROVIDER_ALIASES)) {
      if (internalName === providerName && parsed[authKey]) {
        auth = parsed[authKey];
        break;
      }
    }
  }
  if (!auth) {
    const connected = Object.keys(parsed).join(", ") || "none";
    throw new Error(
      `Provider '${providerName}' not found in opencode auth.json. Connected providers: ${connected}`
    );
  }
  return auth;
}

// --- OAuth Fetch ---
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
const MCP_TOOL_PREFIX = "mcp_";

export function createOAuthFetch(
  statePath: string,
  providerName: string
): (input: string | Request | URL, init?: RequestInit) => Promise<Response> {
  return async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
    let auth = readOpencodeAuth(statePath, providerName) as OAuthAuth;

    // Refresh token if expired
    if (!auth.access || auth.expires < Date.now()) {
      const refreshResponse = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: auth.refresh,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
      if (!refreshResponse.ok) {
        throw new Error(`OAuth token refresh failed: ${refreshResponse.status}`);
      }
      const json = (await refreshResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      auth = {
        type: "oauth",
        refresh: json.refresh_token,
        access: json.access_token,
        expires: Date.now() + json.expires_in * 1000,
      };

      const authPath = findAuthJsonPath(statePath);
      if (authPath) {
        try {
          const allAuth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, Auth>;
          allAuth[providerName] = auth;
          writeFileSync(authPath, JSON.stringify(allAuth));
        } catch {}
      }
    }

    // Build headers
    const requestInit = init ?? {};
    const requestHeaders = new Headers();
    if (input instanceof Request) {
      input.headers.forEach((value, key) => requestHeaders.set(key, value));
    }
    if (requestInit.headers) {
      if (requestInit.headers instanceof Headers) {
        requestInit.headers.forEach((value, key) => requestHeaders.set(key, value));
      } else if (Array.isArray(requestInit.headers)) {
        for (const pair of requestInit.headers) {
          const [key, value] = pair as [string, string];
          if (typeof value !== "undefined") requestHeaders.set(key, value);
        }
      } else {
        for (const [key, value] of Object.entries(requestInit.headers as Record<string, string>)) {
          if (typeof value !== "undefined") requestHeaders.set(key, String(value));
        }
      }
    }

    // Merge beta headers
    const incomingBeta = requestHeaders.get("anthropic-beta") ?? "";
    const incomingBetas = incomingBeta
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    const mergedBetas = [...new Set([...OAUTH_REQUIRED_BETAS, ...incomingBetas])].join(",");

    requestHeaders.set("authorization", `Bearer ${auth.access}`);
    requestHeaders.set("anthropic-beta", mergedBetas);
    requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");
    requestHeaders.delete("x-api-key");

    // Prefix tool names in request body
    let body = requestInit.body;
    if (body && typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed.tools && Array.isArray(parsed.tools)) {
          parsed.tools = (parsed.tools as Array<Record<string, unknown>>).map((tool) => ({
            ...tool,
            name: tool.name ? `${MCP_TOOL_PREFIX}${tool.name as string}` : tool.name,
          }));
        }
        if (parsed.messages && Array.isArray(parsed.messages)) {
          parsed.messages = (parsed.messages as Array<Record<string, unknown>>).map((msg) => {
            if (msg.content && Array.isArray(msg.content)) {
              msg.content = (msg.content as Array<Record<string, unknown>>).map((block) => {
                if (block.type === "tool_use" && block.name) {
                  return { ...block, name: `${MCP_TOOL_PREFIX}${block.name as string}` };
                }
                return block;
              });
            }
            return msg;
          });
        }
        body = JSON.stringify(parsed);
      } catch {}
    }

    // Modify URL: add ?beta=true to /v1/messages
    let requestInput: string | Request | URL = input;
    try {
      let requestUrl: URL | null = null;
      if (typeof input === "string" || input instanceof URL) {
        requestUrl = new URL(input.toString());
      } else if (input instanceof Request) {
        requestUrl = new URL(input.url);
      }
      if (requestUrl?.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
        requestUrl.searchParams.set("beta", "true");
        requestInput =
          input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
      }
    } catch {}

    const response = await fetch(requestInput, { ...requestInit, body, headers: requestHeaders });

    // Strip mcp_ prefix from tool names in streaming response
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          let text = decoder.decode(value, { stream: true });
          text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
          controller.enqueue(encoder.encode(text));
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
}

// --- Provider ---
export function createOpencodeAIProvider(providerName: string, auth: Auth, statePath?: string) {
  if (providerName === "anthropic") {
    if (auth.type === "oauth") {
      if (!statePath) throw new Error("statePath is required for OAuth authentication");
      return createAnthropic({
        apiKey: "",
        fetch: createOAuthFetch(statePath, providerName) as unknown as typeof globalThis.fetch,
      });
    }
    return createAnthropic({ apiKey: auth.key });
  }
  if (providerName === "openai") {
    if (auth.type === "oauth") {
      throw new Error("OpenAI does not support OAuth authentication. Use an API key instead.");
    }
    return createOpenAI({ apiKey: auth.key });
  }
  if (providerName === "minimax") {
    if (auth.type === "oauth") {
      throw new Error("Minimax does not support OAuth authentication. Use an API key instead.");
    }
    return createMinimaxOpenAI({ apiKey: auth.key });
  }
  if (providerName === "minimax-cn-coding-plan") {
    if (auth.type === "oauth") {
      throw new Error("Minimax does not support OAuth authentication. Use an API key instead.");
    }
    return createMinimax({
      apiKey: auth.key,
      baseURL: "https://api.minimaxi.com/anthropic/v1"
    });
  }
  if (providerName === "minimax-cn") {
    if (auth.type === "oauth") {
      throw new Error("Minimax does not support OAuth authentication. Use an API key instead.");
    }
    return createMinimaxOpenAI({ apiKey: auth.key });
  }
  throw new Error(
    `Unsupported opencode provider: '${providerName}'. Supported providers: anthropic, openai, minimax, minimax-cn-coding-plan, minimax-cn`
  );
}

// --- Structured Output ---
export async function generateStructuredOutput<T>(options: {
  providerName: string;
  modelId: string;
  statePath: string;
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  temperature?: number;
}): Promise<T> {
  const auth = readOpencodeAuth(options.statePath, options.providerName);
  const provider = createOpencodeAIProvider(options.providerName, auth, options.statePath);
  const result = await generateText({
    model: provider(options.modelId),
    system: options.systemPrompt,
    prompt: options.userPrompt,
    output: Output.object({ schema: options.schema }),
    temperature: options.temperature ?? 0.3,
  });
  return result.output as T;
}
