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
 * The primary transport is the authenticated v2 SDK client initialized from
 * the plugin host's client configuration. A raw fetch fallback remains for
 * older SDK builds that do not expose the v2 session methods.
 */

import type { z } from "zod";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  diagnosticUrl,
  readJson,
  responseStatus,
  type FetchEndpoint,
} from "./opencode-diagnostics.js";
import { createLazyV2Client, type HostTransport } from "./opencode-sdk-client.js";

let _connectedProviders: Set<string> = new Set();
let _v2Client: OpencodeClient | undefined;
let _v2BaseUrl: string | undefined;
let _hostFetch: typeof fetch | undefined;
let _useSdkTransport = false;

export function setHostFetch(customFetch: typeof fetch): void {
  _hostFetch = customFetch;
}

export function resetHostFetch(): void {
  _hostFetch = undefined;
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

export function createV2Client(serverUrl: URL | string, transport?: HostTransport): OpencodeClient {
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl.toString();
  const activeTransport = transport ?? (_hostFetch ? { fetch: _hostFetch } : undefined);
  _v2BaseUrl = baseUrl;
  _useSdkTransport = Boolean(activeTransport?.fetch || activeTransport?.headers);
  return createLazyV2Client(baseUrl, activeTransport);
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
  const { client, providerID, modelID, systemPrompt, userPrompt, schema, directory, retryCount } =
    opts;

  const jsonSchema =
    (
      schema as unknown as {
        toJSONSchema?: () => Record<string, unknown>;
      }
    ).toJSONSchema?.() ?? (await import("zod")).z.toJSONSchema(schema);

  if (_useSdkTransport && hasV2SessionClient(client)) {
    return generateViaSdkClient(client, {
      providerID,
      modelID,
      systemPrompt,
      userPrompt,
      directory,
      retryCount,
      jsonSchema,
      schema,
    });
  }

  const baseUrl = _v2BaseUrl;
  if (!baseUrl) {
    throw new Error(
      "opencode-mem: v2 server base URL not initialized; call createV2Client(serverUrl) first"
    );
  }
  const base = stripTrailingSlash(baseUrl);

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
      throw new Error(
        `opencode-mem: opencode reported ${info.error.name}: ${formatAssistantError(info.error)}`
      );
    }

    const structuredOutput = info.structured_output ?? info.structured;
    if (structuredOutput === undefined || structuredOutput === null) {
      throw new Error(
        "opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)"
      );
    }

    return schema.parse(structuredOutput);
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

type V2SessionClient = {
  session: {
    create(parameters?: Record<string, unknown>): Promise<unknown>;
    prompt(parameters: Record<string, unknown>): Promise<unknown>;
    delete(parameters: Record<string, unknown>): Promise<unknown>;
  };
};

interface SdkStructuredOutputArgs<T> {
  providerID: string;
  modelID: string;
  systemPrompt: string;
  userPrompt: string;
  directory?: string;
  retryCount?: number;
  jsonSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
}

function hasV2SessionClient(client: OpencodeClient): client is OpencodeClient & V2SessionClient {
  const session = (client as unknown as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) return false;
  const candidate = session as Record<string, unknown>;
  return (
    typeof candidate.create === "function" &&
    typeof candidate.prompt === "function" &&
    typeof candidate.delete === "function"
  );
}

async function generateViaSdkClient<T>(
  client: OpencodeClient & V2SessionClient,
  args: SdkStructuredOutputArgs<T>
): Promise<T> {
  const createdResponse = await client.session.create({
    title: "opencode-mem capture",
    ...(args.directory ? { directory: args.directory } : {}),
  });
  const created = readSdkData<{ id?: string }>(createdResponse, "POST /session");
  if (!created.id) {
    throw new Error(
      "opencode-mem: session.create returned no session id; cannot generate structured output"
    );
  }

  const sessionID = created.id;
  try {
    const promptResponse = await client.session.prompt({
      sessionID,
      ...(args.directory ? { directory: args.directory } : {}),
      model: { providerID: args.providerID, modelID: args.modelID },
      system: args.systemPrompt,
      parts: [{ type: "text", text: args.userPrompt }],
      format: {
        type: "json_schema",
        schema: args.jsonSchema,
        ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
      },
    });
    const data = readSdkData<MessageV2WithParts>(promptResponse, "POST /session/{id}/message");
    if (!data.info) {
      throw new Error("opencode-mem: prompt response missing `info`");
    }
    if (data.info.error) {
      throw new Error(
        `opencode-mem: opencode reported ${data.info.error.name}: ${formatAssistantError(data.info.error)}`
      );
    }

    const structuredOutput = data.info.structured_output ?? data.info.structured;
    if (structuredOutput === undefined || structuredOutput === null) {
      throw new Error(
        "opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)"
      );
    }
    return args.schema.parse(structuredOutput);
  } finally {
    try {
      await client.session.delete({
        sessionID,
        ...(args.directory ? { directory: args.directory } : {}),
      });
    } catch {
      // Best-effort cleanup for the transient capture session.
    }
  }
}

function readSdkData<T>(response: unknown, label: string): T {
  const result = response as
    { data?: T; error?: unknown; request?: Request; response?: Response } | undefined;
  if (result?.error !== undefined) {
    const status = result.response ? ` (${responseStatus(result.response)})` : "";
    const responseUrl = result.response?.url || result.request?.url;
    const url = responseUrl ? diagnosticUrl(responseUrl) : "the authenticated client";
    throw new Error(
      `opencode-mem: opencode ${label} failed at ${url}${status}: <redacted response body>`
    );
  }
  if (result?.data === undefined) {
    throw new Error(`opencode-mem: opencode ${label} returned no response data`);
  }
  return result.data;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildQuery(directory?: string): string {
  if (!directory) return "";
  return `?directory=${encodeURIComponent(directory)}`;
}

async function fetchJson<T>(endpoint: FetchEndpoint, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await activeFetch()(new Request(endpoint.url, init));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `opencode-mem: failed to fetch ${endpoint.label} at ${diagnosticUrl(endpoint.url)}: ${message}`
    );
  }

  return readJson<T>(res, endpoint);
}

async function createSession(base: string, directory?: string): Promise<string> {
  const url = `${base}/session${buildQuery(directory)}`;
  const body = await fetchJson<{ id?: string }>(
    { label: "POST /session", url },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "opencode-mem capture" }),
    }
  );
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
  structured_output?: unknown;
  error?: { name: string; data?: { message?: string; [key: string]: unknown } };
}

function formatAssistantError(error: NonNullable<AssistantInfo["error"]>): string {
  if (!error.data) return error.name;

  const details = safeAssistantErrorDetails(error.data);
  if (!error.data.message) return details;

  return details ? `${error.data.message}; ${details}` : error.data.message;
}

function safeAssistantErrorDetails(
  data: NonNullable<NonNullable<AssistantInfo["error"]>["data"]>
): string {
  const safeFields: Record<string, unknown> = {};
  for (const key of ["statusCode", "providerID", "modelID"] as const) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safeFields[key] = value;
    }
  }

  const entries = Object.entries(safeFields);
  if (entries.length === 0) return "";
  return `details=${JSON.stringify(Object.fromEntries(entries))}`;
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
    // `noReply` suppresses assistant generation in current OpenCode builds,
    // which also suppresses `info.structured_output`; structured capture needs
    // the assistant run even though the temporary session is deleted afterward.
    format: {
      type: "json_schema",
      schema: args.jsonSchema,
      ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
    },
  };
  const data = await fetchJson<MessageV2WithParts>(
    { label: "POST /session/{id}/message", url },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!data.info) {
    throw new Error("opencode-mem: prompt response missing `info`");
  }
  return data.info;
}

async function deleteSession(base: string, sessionID: string, directory?: string): Promise<void> {
  const url = `${base}/session/${encodeURIComponent(sessionID)}${buildQuery(directory)}`;
  let res: Response;
  try {
    res = await activeFetch()(new Request(url, { method: "DELETE" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `opencode-mem: failed to fetch DELETE /session/{id} at ${diagnosticUrl(url)}: ${message}`
    );
  }
  // DELETE /session/:id returns boolean. We only care that it ran; failures
  // are swallowed at the call site.
  if (!res.ok) {
    throw new Error(
      `opencode-mem: opencode DELETE /session/{id} failed at ${diagnosticUrl(url)} (${responseStatus(res)})`
    );
  }
}

function activeFetch(): typeof fetch {
  return _hostFetch ?? globalThis.fetch;
}
