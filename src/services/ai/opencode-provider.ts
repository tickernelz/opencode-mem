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
 * Internal capture sessions are least-privilege (issue #189): ordinary
 * agent tools are denied, only StructuredOutput is allowed, a dedicated
 * agent caps steps, and a hard timeout fails closed.
 *
 * The primary transport is the authenticated v2 SDK client initialized from
 * the plugin host's client configuration. A raw fetch fallback remains for
 * older SDK builds that do not expose the v2 session methods.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  diagnosticUrl,
  readJson,
  responseStatus,
  type FetchEndpoint,
} from "./opencode-diagnostics.js";
import {
  INTERNAL_CAPTURE_SESSION_TITLE,
  trackInternalCaptureSession,
  untrackInternalCaptureSession,
} from "./internal-capture-sessions.js";
import { createLazyV2Client, type HostTransport } from "./opencode-sdk-client.js";

/** Dedicated agent registered via the plugin config hook (step-capped). */
export const STRUCTURED_OUTPUT_AGENT = "opencode-mem-structured";

/** Hard ceiling for a single internal structured-output prompt. */
export const STRUCTURED_OUTPUT_TIMEOUT_MS = 90_000;

let _structuredOutputTimeoutMs = STRUCTURED_OUTPUT_TIMEOUT_MS;

/** Test helper: override the structured-output prompt timeout. Pass undefined to reset. */
export function setStructuredOutputTimeoutMsForTests(ms: number | undefined): void {
  _structuredOutputTimeoutMs = ms ?? STRUCTURED_OUTPUT_TIMEOUT_MS;
}

export const STRUCTURED_OUTPUT_PERMISSIONS = [
  { permission: "*", pattern: "*", action: "deny" as const },
  { permission: "StructuredOutput", pattern: "*", action: "allow" as const },
];

export const STRUCTURED_OUTPUT_TOOLS: Record<string, boolean> = {
  "*": false,
  StructuredOutput: true,
};

export const STRUCTURED_OUTPUT_METADATA = {
  "opencode-mem": {
    internal: true,
    purpose: "structured-output",
  },
};

const _internalSessions = new Set<string>();

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

/** True while an internal structured-output session is live (create → delete). */
export function isInternalStructuredSession(sessionID: string): boolean {
  return _internalSessions.has(sessionID);
}

/** Test helper: clear tracked internal session IDs. */
export function resetInternalStructuredSessions(): void {
  _internalSessions.clear();
}

function markInternalSession(sessionID: string): void {
  _internalSessions.add(sessionID);
}

function unmarkInternalSession(sessionID: string): void {
  _internalSessions.delete(sessionID);
}

function sessionCreateBody(): Record<string, unknown> {
  return {
    title: INTERNAL_CAPTURE_SESSION_TITLE,
    permission: STRUCTURED_OUTPUT_PERMISSIONS,
    metadata: STRUCTURED_OUTPUT_METADATA,
  };
}

function sessionPromptFields(args: {
  providerID: string;
  modelID: string;
  variant?: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  retryCount?: number;
}): Record<string, unknown> {
  return {
    model: {
      providerID: args.providerID,
      modelID: args.modelID,
      ...(args.variant ? { variant: args.variant } : {}),
    },
    agent: STRUCTURED_OUTPUT_AGENT,
    system: args.systemPrompt,
    parts: [{ type: "text", text: args.userPrompt }],
    tools: STRUCTURED_OUTPUT_TOOLS,
    // `noReply` suppresses assistant generation in current OpenCode builds,
    // which also suppresses `info.structured_output`; structured capture needs
    // the assistant run even though the temporary session is deleted afterward.
    format: {
      type: "json_schema",
      schema: args.jsonSchema,
      ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
    },
  };
}

export interface StructuredOutputOptions<T> {
  client: OpencodeClient;
  providerID: string;
  modelID: string;
  variant?: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  directory?: string;
  retryCount?: number;
}

/**
 * Resolve `opencodeModel: "inherit"` to a concrete provider/model.
 *
 * Prefer an explicit prompt-recorded model (auto-capture path). Otherwise fall
 * back to OpenCode's recent model list so profile-learning / conflict / dedup
 * paths don't send the literal model id "inherit" (ProviderModelNotFoundError).
 */
export function resolveOpencodeModelRef(opts: {
  providerID: string;
  modelID: string;
  prompt?: { providerId?: string | null; modelId?: string | null };
}): { providerID: string; modelID: string } {
  if (opts.modelID !== "inherit") {
    return { providerID: opts.providerID, modelID: opts.modelID };
  }

  if (opts.prompt?.providerId && opts.prompt?.modelId) {
    return { providerID: opts.prompt.providerId, modelID: opts.prompt.modelId };
  }

  const recent = readRecentOpencodeModel(opts.providerID);
  if (recent) return recent;

  throw new Error(
    "opencode-mem: opencodeModel is 'inherit' but no session model was recorded and no recent OpenCode model is available"
  );
}

function readRecentOpencodeModel(
  preferredProvider?: string
): { providerID: string; modelID: string } | undefined {
  try {
    // OpenCode state path mirrors `opencode debug paths` → state.
    const stateDir = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    const modelPath = join(stateDir, "opencode", "model.json");
    if (!existsSync(modelPath)) return undefined;
    const raw = JSON.parse(readFileSync(modelPath, "utf8")) as {
      recent?: Array<{ providerID?: string; modelID?: string }>;
    };
    const recent = Array.isArray(raw.recent) ? raw.recent : [];
    const match =
      (preferredProvider
        ? recent.find((r) => r.providerID === preferredProvider && r.modelID)
        : undefined) ?? recent.find((r) => r.providerID && r.modelID);
    if (!match?.providerID || !match.modelID) return undefined;
    return { providerID: match.providerID, modelID: match.modelID };
  } catch {
    return undefined;
  }
}

/**
 * Generate one structured-output completion via opencode's HTTP API.
 * Throws on: session.create failure, prompt failure, AssistantMessage.error
 * (StructuredOutputError / ApiError / ...), missing `info.structured`,
 * timeout, or final Zod validation failure.
 */
export async function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T> {
  const resolved = resolveOpencodeModelRef({
    providerID: opts.providerID,
    modelID: opts.modelID,
  });
  const { client, systemPrompt, userPrompt, schema, directory, retryCount, variant } = opts;
  const { providerID, modelID } = resolved;

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
      variant,
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
  markInternalSession(sessionID);
  try {
    const info = await withStructuredOutputTimeout(
      () =>
        promptSession(base, {
          sessionID,
          directory,
          providerID,
          modelID,
          variant,
          systemPrompt,
          userPrompt,
          jsonSchema,
          retryCount,
        }),
      () => abortSession(base, sessionID, directory)
    );

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
    unmarkInternalSession(sessionID);
    // Best-effort: leaving a transient session behind is cosmetic, not
    // worth failing a successful capture if cleanup itself errors.
    try {
      await deleteSession(base, sessionID, directory);
    } catch {
      // intentionally swallowed
    } finally {
      untrackInternalCaptureSession(sessionID);
    }
  }
}

type V2SessionClient = {
  session: {
    create(parameters?: Record<string, unknown>): Promise<unknown>;
    prompt(parameters: Record<string, unknown>): Promise<unknown>;
    delete(parameters: Record<string, unknown>): Promise<unknown>;
    abort?(parameters: Record<string, unknown>): Promise<unknown>;
  };
};

interface SdkStructuredOutputArgs<T> {
  providerID: string;
  modelID: string;
  variant?: string;
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
    ...sessionCreateBody(),
    ...(args.directory ? { directory: args.directory } : {}),
  });
  const created = readSdkData<{ id?: string }>(createdResponse, "POST /session");
  if (!created.id) {
    throw new Error(
      "opencode-mem: session.create returned no session id; cannot generate structured output"
    );
  }

  const sessionID = created.id;
  trackInternalCaptureSession(sessionID);
  markInternalSession(sessionID);
  try {
    const promptResponse = await withStructuredOutputTimeout(
      () =>
        client.session.prompt({
          sessionID,
          ...(args.directory ? { directory: args.directory } : {}),
          ...sessionPromptFields(args),
        }),
      () =>
        client.session.abort?.({
          sessionID,
          ...(args.directory ? { directory: args.directory } : {}),
        })
    );
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
    unmarkInternalSession(sessionID);
    try {
      await client.session.delete({
        sessionID,
        ...(args.directory ? { directory: args.directory } : {}),
      });
    } catch {
      // Best-effort cleanup for the transient capture session.
    } finally {
      untrackInternalCaptureSession(sessionID);
    }
  }
}

async function withStructuredOutputTimeout<T>(
  run: () => Promise<T>,
  onTimeout: () => unknown
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = _structuredOutputTimeoutMs;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`opencode-mem: structured-output timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([run(), timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("structured-output timed out after")) {
      try {
        await onTimeout();
      } catch {
        // best-effort abort
      }
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
      body: JSON.stringify(sessionCreateBody()),
    }
  );
  if (!body.id) {
    throw new Error(
      "opencode-mem: session.create returned no session id; cannot generate structured output"
    );
  }
  trackInternalCaptureSession(body.id);
  return body.id;
}

interface PromptSessionArgs {
  sessionID: string;
  directory?: string;
  providerID: string;
  modelID: string;
  variant?: string;
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
  const body = sessionPromptFields(args);
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

async function abortSession(base: string, sessionID: string, directory?: string): Promise<void> {
  const url = `${base}/session/${encodeURIComponent(sessionID)}/abort${buildQuery(directory)}`;
  try {
    await activeFetch()(new Request(url, { method: "POST" }));
  } catch {
    // best-effort
  }
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
