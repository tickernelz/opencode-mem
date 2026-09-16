import type { Context } from "@opencode/plugin/promise/plugin";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

function textFromParts(parts: Array<{ type?: string; text?: string }> = []): string {
  return parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Model did not return a JSON object");
  }
}

function legacyMessage(message: any, sessionID: string): any {
  if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
    return {
      info: { id: message.id, sessionID, role: "user", agent: message.agent },
      parts: [{ id: `${message.id}-text`, sessionID, messageID: message.id, type: "text", text: message.text ?? "", synthetic: message.type !== "user" }],
    };
  }
  if (message.type === "assistant") {
    return {
      info: { id: message.id, sessionID, role: "assistant", agent: message.agent, mode: message.agent },
      parts: (message.content ?? []).map((part: any, index: number) => ({
        id: part.id ?? `${message.id}-${index}`,
        sessionID,
        messageID: message.id,
        ...part,
      })),
    };
  }
  if (message.type === "compaction") {
    return { info: { id: message.id, sessionID, role: "assistant", summary: true, mode: "compaction" }, parts: [] };
  }
  return { info: { id: message.id ?? randomUUID(), sessionID, role: "assistant" }, parts: [] };
}

export function createLegacyClient(ctx: Context) {
  const ephemeral = new Set<string>();
  return {
    app: { log: async () => ({ data: true }) },
    provider: { list: async () => ({ data: { connected: [] } }) },
    tui: {
      showToast: async () => ({ data: false }),
      appendPrompt: async () => ({ data: false }),
      submitPrompt: async () => ({ data: false }),
    },
    session: {
      get: async ({ path }: any) => ({ data: await ctx.session.get({ sessionID: path.id }) }),
      messages: async ({ path }: any) => ({
        data: (await ctx.session.context({ sessionID: path.id })).map((message: any) =>
          legacyMessage(message, path.id)
        ),
      }),
      create: async (input: any = {}) => {
        const id = randomUUID();
        ephemeral.add(id);
        return { data: { id, parentID: input.body?.parentID } };
      },
      prompt: async ({ path, body }: any) => {
        const sessionID = path.id;
        if (ephemeral.has(sessionID)) {
          const model = body?.model?.providerID && body?.model?.modelID
            ? { providerID: body.model.providerID, id: body.model.modelID }
            : undefined;
          const prompt = [body?.system, textFromParts(body?.parts)].filter(Boolean).join("\n\n");
          const generated = await ctx.generate.text({ prompt, ...(model ? { model } : {}) });
          const text = generated?.text ?? "";
          const structured = body?.format?.type === "json_schema" ? parseJson(text) : undefined;
          return { data: { info: { id: randomUUID(), role: "assistant", structured_output: structured }, parts: [{ type: "text", text }] } };
        }
        const text = textFromParts(body?.parts);
        if (body?.noReply) {
          const data = await ctx.session.synthetic({ sessionID, text, description: "memory context", metadata: body?.parts?.[0]?.metadata });
          return { data, response: new Response(null, { status: 200 }) };
        }
        const data = await ctx.session.prompt({ sessionID, text, delivery: "queue", metadata: body?.parts?.[0]?.metadata });
        return { data, response: new Response(null, { status: 200 }) };
      },
      abort: async () => ({ data: true }),
      delete: async ({ path }: any) => {
        ephemeral.delete(path.id);
        return { data: true };
      },
    },
  } as any;
}

export function legacyToolResult(value: unknown): { content: string; metadata?: unknown } {
  if (typeof value === "string") return { content: value };
  if (value && typeof value === "object" && typeof (value as any).output === "string") {
    return { content: (value as any).output, metadata: (value as any).metadata };
  }
  return { content: JSON.stringify(value ?? null) };
}

export function toLegacyEvent(raw: any): { type: string; properties: any } {
  const envelope = raw?.payload ?? raw;
  const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
  const type = typeof source?.type === "string" ? source.type.replace(/\.1$/, "") : source?.type;
  const data = source?.data ?? {};
  if (source && typeof source === "object" && "properties" in source) {
    return { type, properties: source.properties };
  }
  if (type === "session.created" || type === "session.updated") {
    return { type, properties: { info: data.session ?? data.info ?? data } };
  }
  return { type, properties: data };
}

export async function eventBelongsToLocation(ctx: Context, raw: any): Promise<boolean> {
  const directory = raw?.directory ?? raw?.payload?.directory ?? raw?.data?.info?.directory;
  if (typeof directory === "string") return resolve(directory) === resolve(ctx.location.directory);
  const data = raw?.data ?? raw?.payload?.data ?? raw?.properties;
  const sessionID = data?.sessionID ?? data?.session?.id ?? data?.info?.id;
  if (!sessionID) return false;
  try {
    const session: any = await ctx.session.get({ sessionID });
    const sessionDirectory = session?.directory ?? session?.data?.directory;
    return typeof sessionDirectory === "string" && resolve(sessionDirectory) === resolve(ctx.location.directory);
  } catch {
    return false;
  }
}
