/**
 * Structured output via the opencode HTTP server.
 *
 * Replaces the older auth.json/OAuth-juggling flow. Instead of forging
 * requests to provider HTTP endpoints ourselves, we delegate to the
 * running opencode server: it already owns the user's auth (any provider,
 * including github-copilot personal/business), token refresh, and provider
 * routing.
 *
 * Per call we create a transient session, prompt it with a JSON schema,
 * then delete the session so it does not pollute the user's TUI session
 * list.
 *
 * We intentionally bypass the `@opencode-ai/sdk` client for these three
 * endpoints. Issue #110 showed that relying on `client.session.create` /
 * `client.session.prompt` / `client.session.delete` is brittle: the SDK
 * class layout has shifted across releases (e.g. v1.14.48's `Session` only
 * exposes `list()` in some builds, with the real methods living on a
 * renamed `Session2` reachable via a different property path). Going
 * straight to `fetch` against the documented server endpoints
 * (`POST /session`, `POST /session/{id}/message`, `DELETE /session/{id}`)
 * makes us resilient to those SDK churns and lets us test the wire
 * protocol directly with a `globalThis.fetch` stub.
 */

import type { z } from "zod";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

let _connectedProviders: Set<string> = new Set();
let _v2Client: OpencodeClient | undefined;
let _v2BaseUrl: string | undefined;

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
  _v2BaseUrl = baseUrl;
  return createOpencodeClient({ baseUrl });
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
 * Generate one structured-output completion via opencode's HTTP API.
 * Throws on: session.create failure, prompt failure, AssistantMessage.error
 * (StructuredOutputError / ApiError / ...), missing `info.structured`,
 * or final Zod validation failure.
 */
export async function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T> {
  const { providerID, modelID, systemPrompt, userPrompt, schema, directory, retryCount } = opts;

  const baseUrl = _v2BaseUrl;
  if (!baseUrl) {
    throw new Error(
      "opencode-mem: v2 server base URL not initialized; call createV2Client(serverUrl) first"
    );
  }
  const base = stripTrailingSlash(baseUrl);

  // zod v4 exposes JSON Schema export natively (instance `.toJSONSchema()`
  // and global `z.toJSONSchema()`); we prefer instance, fall back to global.
  // This avoids pulling in a separate `zod-to-json-schema` dependency.
  const jsonSchema =
    (
      schema as unknown as {
        toJSONSchema?: () => Record<string, unknown>;
      }
    ).toJSONSchema?.() ?? (await import("zod")).z.toJSONSchema(schema);

  const sessionID = await createSession(base, directory);
  try {
    const info = await promptSession(base, {
      sessionID,
      directory,
      providerID,
      modelID,
      systemPrompt,
      userPrompt,
      jsonSchema,
      retryCount,
    });

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
      await deleteSession(base, sessionID, directory);
    } catch {
      // intentionally swallowed
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildQuery(directory?: string): string {
  if (!directory) return "";
  return `?directory=${encodeURIComponent(directory)}`;
}

async function readJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `opencode-mem: opencode ${context} failed (${res.status} ${res.statusText}): ${text || "<empty body>"}`
    );
  }
  if (!text) {
    throw new Error(`opencode-mem: opencode ${context} returned an empty response body`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `opencode-mem: opencode ${context} returned non-JSON body: ${text.slice(0, 200)}`
    );
  }
}

async function createSession(base: string, directory?: string): Promise<string> {
  const url = `${base}/session${buildQuery(directory)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "opencode-mem capture" }),
  });
  const body = await readJson<{ id?: string }>(res, "POST /session");
  if (!body.id) {
    throw new Error(
      "opencode-mem: session.create returned no session id; cannot generate structured output"
    );
  }
  return body.id;
}

interface PromptSessionArgs {
  sessionID: string;
  directory?: string;
  providerID: string;
  modelID: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  retryCount?: number;
}

interface AssistantInfo {
  structured?: unknown;
  error?: { name: string; data?: { message?: string } };
}

interface MessageV2WithParts {
  info: AssistantInfo;
  parts: unknown[];
}

async function promptSession(base: string, args: PromptSessionArgs): Promise<AssistantInfo> {
  const url = `${base}/session/${encodeURIComponent(args.sessionID)}/message${buildQuery(args.directory)}`;
  const body: Record<string, unknown> = {
    model: { providerID: args.providerID, modelID: args.modelID },
    system: args.systemPrompt,
    parts: [{ type: "text", text: args.userPrompt }],
    format: {
      type: "json_schema",
      schema: args.jsonSchema,
      ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
    },
    noReply: true,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson<MessageV2WithParts>(res, "POST /session/{id}/message");
  if (!data.info) {
    throw new Error("opencode-mem: prompt response missing `info`");
  }
  return data.info;
}

async function deleteSession(base: string, sessionID: string, directory?: string): Promise<void> {
  const url = `${base}/session/${encodeURIComponent(sessionID)}${buildQuery(directory)}`;
  const res = await fetch(url, { method: "DELETE" });
  // DELETE /session/:id returns boolean. We only care that it ran; failures
  // are swallowed at the call site.
  if (!res.ok) {
    throw new Error(`delete failed: ${res.status} ${res.statusText}`);
  }
}
