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
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

type SessionCreateResult = {
  data?: { id?: string };
  id?: string;
  error?: { message?: string; data?: { message?: string } };
  response?: { status?: number; statusText?: string };
};

type SessionPromptResult = {
  data?: {
    info?: {
      structured?: unknown;
      error?: { name: string; data?: { message?: string } };
    };
  };
};

export interface StructuredOutputClient {
  session: {
    create(input: Record<string, unknown>): Promise<SessionCreateResult>;
    prompt(input: Record<string, unknown>): Promise<SessionPromptResult>;
    delete(input: Record<string, unknown>): Promise<unknown>;
  };
}

type InjectedOpencodeClient = {
  session: {
    create(options: unknown): Promise<unknown>;
    prompt(options: unknown): Promise<unknown>;
    delete(options: unknown): Promise<unknown>;
  };
};

let _connectedProviders: Set<string> = new Set();
let _v2Client: StructuredOutputClient | undefined;

export function setConnectedProviders(providers: string[]): void {
  _connectedProviders = new Set(providers);
}

export function isProviderConnected(providerName: string): boolean {
  return _connectedProviders.has(providerName);
}

export function setV2Client(client: StructuredOutputClient | undefined): void {
  _v2Client = client;
}

export function getV2Client(): StructuredOutputClient | undefined {
  return _v2Client;
}

export function createV2Client(serverUrl: URL | string): StructuredOutputClient {
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl.toString();
  return createOpencodeClient({ baseUrl }) as unknown as StructuredOutputClient;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

export function createStructuredOutputClient(
  client: InjectedOpencodeClient
): StructuredOutputClient {
  return {
    session: {
      create: (input) =>
        client.session.create({
          query: compactObject({ directory: input.directory, workspace: input.workspace }),
          body: compactObject({
            parentID: input.parentID,
            title: input.title,
            agent: input.agent,
            model: input.model,
            metadata: input.metadata,
            permission: input.permission,
            workspaceID: input.workspaceID,
          }),
        }) as Promise<SessionCreateResult>,
      prompt: (input) =>
        client.session.prompt({
          path: { id: input.sessionID },
          query: compactObject({ directory: input.directory, workspace: input.workspace }),
          body: compactObject({
            messageID: input.messageID,
            model: input.model,
            agent: input.agent,
            noReply: input.noReply,
            tools: input.tools,
            format: input.format,
            system: input.system,
            variant: input.variant,
            parts: input.parts,
          }),
        }) as Promise<SessionPromptResult>,
      delete: (input) =>
        client.session.delete({
          path: { id: input.sessionID },
          query: compactObject({ directory: input.directory, workspace: input.workspace }),
        }),
    },
  };
}

function summarizeCreateFailure(created: SessionCreateResult): string {
  const status = created?.response?.status;
  const statusText = created?.response?.statusText;
  const message = created?.error?.message ?? created?.error?.data?.message;
  const details = [status ? `status=${status}` : undefined, statusText, message]
    .filter(Boolean)
    .join(" ");
  return details ? ` (${details})` : "";
}

export interface StructuredOutputOptions<T> {
  client: StructuredOutputClient;
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
  const sessionID = created.data?.id ?? created.id;
  if (!sessionID) {
    throw new Error(
      `opencode-mem: session.create returned no session id${summarizeCreateFailure(
        created
      )}; cannot generate structured output`
    );
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

    const data = promptResult.data;

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
