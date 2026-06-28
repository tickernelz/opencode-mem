/**
 * SDK-based structured output via opencode v2 session.prompt.
 *
 * Replaces the old auth.json/OAuth-juggling flow. Instead of forging requests
 * to provider HTTP endpoints ourselves, we delegate to the running opencode
 * server: it already owns the user's auth (any provider, including
 * github-copilot personal/business), token refresh, and provider routing.
 *
 * Per call we create a transient session, prompt with a JSON schema, then
 * delete the session so it does not pollute the user's TUI session list.
 */

import type { z } from "zod";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

let _connectedProviders: Set<string> = new Set();
let _v2Client: OpencodeClient | undefined;
const _clientBaseUrls = new WeakMap<OpencodeClient, string>();
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|password|passwd|secret|apikey|privatekey)/;

function getClientBaseUrl(client: OpencodeClient): string | undefined {
  return _clientBaseUrls.get(client);
}

function sanitizeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return baseUrl;
  }
}

function isSensitiveKey(key: string): boolean {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalizedKey.length > 0 && SENSITIVE_KEY_PATTERN.test(normalizedKey);
}

function summarizeValue(value: unknown, maxLength = 300): string {
  const seen = new WeakSet<object>();
  const replacer = (key: string, currentValue: unknown): unknown => {
    if (isSensitiveKey(key)) {
      return REDACTED;
    }
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
      };
    }
    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }
      seen.add(currentValue);
    }
    return currentValue;
  };

  try {
    const json = JSON.stringify(value, replacer);
    if (json === undefined) {
      return String(value);
    }
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

export function setConnectedProviders(providers: string[]): void {
  _connectedProviders = new Set(providers);
}

export function isProviderConnected(providerName: string): boolean {
  return _connectedProviders.has(providerName);
}

export function setV2Client(client: OpencodeClient): void {
  _v2Client = client;
}

export function getV2Client(): OpencodeClient | undefined {
  return _v2Client;
}

export function createV2Client(serverUrl: URL | string): OpencodeClient {
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl.toString();
  const client = createOpencodeClient({ baseUrl });
  _clientBaseUrls.set(client, baseUrl);
  return client;
}

export interface StructuredOutputOptions<T> {
  client: OpencodeClient;
  providerID: string;
  modelID: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  directory?: string;
  retryCount?: number;
}

/**
 * Generate one structured-output completion via opencode's v2 API.
 * Throws on: session.create failure, prompt failure, AssistantMessage.error
 * (StructuredOutputError / ApiError / ...), missing `info.structured`,
 * or final Zod validation failure.
 */
export async function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T> {
  const { client, providerID, modelID, systemPrompt, userPrompt, schema, directory, retryCount } =
    opts;

  // zod v4 exposes JSON Schema export natively (instance `.toJSONSchema()`
  // and global `z.toJSONSchema()`); we prefer instance, fall back to global.
  // This avoids pulling in a separate `zod-to-json-schema` dependency.
  const jsonSchema =
    (
      schema as unknown as {
        toJSONSchema?: () => Record<string, unknown>;
      }
    ).toJSONSchema?.() ?? (await import("zod")).z.toJSONSchema(schema);

  const created = await client.session.create({
    title: "opencode-mem capture",
    ...(directory ? { directory } : {}),
  });
  const sessionID = (created as { data?: { id?: string } })?.data?.id;
  if (!sessionID) {
    const diagnostics = ["opencode-mem: session.create returned no session id"];
    const baseUrl = getClientBaseUrl(client);
    if (baseUrl) {
      diagnostics.push(`baseUrl=${sanitizeBaseUrl(baseUrl)}`);
    }
    diagnostics.push(`response=${summarizeValue(created)}`);
    throw new Error(`${diagnostics.join("; ")}; cannot generate structured output`);
  }

  try {
    const promptResult = await client.session.prompt({
      sessionID,
      ...(directory ? { directory } : {}),
      model: { providerID, modelID },
      system: systemPrompt,
      parts: [{ type: "text", text: userPrompt }],
      format: {
        type: "json_schema",
        schema: jsonSchema as Record<string, unknown>,
        ...(retryCount !== undefined ? { retryCount } : {}),
      },
      noReply: true,
    });

    const data = (
      promptResult as {
        data?: {
          info?: {
            structured?: unknown;
            error?: { name: string; data?: { message?: string } };
          };
        };
      }
    ).data;

    const info = data?.info;
    if (!info) {
      throw new Error("opencode-mem: prompt response missing `info`");
    }

    if (info.error) {
      const msg = info.error.data?.message ?? info.error.name;
      throw new Error(`opencode-mem: opencode reported ${info.error.name}: ${msg}`);
    }

    if (info.structured === undefined || info.structured === null) {
      throw new Error(
        "opencode-mem: opencode returned no structured output (info.structured was empty)"
      );
    }

    return schema.parse(info.structured);
  } finally {
    // Best-effort: leaving a transient session behind is cosmetic, not
    // worth failing a successful capture if cleanup itself errors.
    try {
      await client.session.delete({
        sessionID,
        ...(directory ? { directory } : {}),
      });
    } catch {
      // intentionally swallowed
    }
  }
}
