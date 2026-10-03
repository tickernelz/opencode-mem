import type { Context } from "@opencode/plugin/promise/plugin";
import { log } from "../infra/logger.js";
import { eventBelongsToLocation, legacyToolResult, toLegacyEvent } from "./legacy-client.js";

interface MemoryContextHooks {
  enabled(): boolean;
  refreshOnPrompt(): boolean;
  capturePrompt(
    input: { sessionID: string },
    output: { message: { id: string }; parts: any[] }
  ): Promise<boolean>;
  load(sessionID: string): Promise<string>;
}

const memoryInput = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: [
        "add",
        "search",
        "profile",
        "list",
        "forget",
        "help",
        "migrate",
        "list-shards",
        "export",
        "import",
      ],
    },
    content: { type: "string" },
    query: { type: "string" },
    tags: { type: "string" },
    type: { type: "string" },
    memoryId: { type: "string" },
    limit: { type: "number" },
    scope: { type: "string", enum: ["project", "all-projects"] },
    fromPath: { type: "string" },
    fromHash: { type: "string" },
    outputPath: { type: "string" },
    inputPath: { type: "string" },
    dryRun: { type: "boolean" },
    allowLinkedSource: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

export async function registerV2Adapter(ctx: Context, legacy: any) {
  const contexts = new Map<string, string>();
  const messageIDs = new Map<string, string>();
  const suppressed = new Set<string>();
  const memoryContext = legacy.memoryContext as MemoryContextHooks | undefined;

  await ctx.tool.transform((editor) =>
    editor.add({
      name: "memory",
      description: legacy.tool.memory.description,
      input: memoryInput as any,
      execute: async (args: any, toolContext: any) =>
        legacyToolResult(
          await legacy.tool.memory.execute(args, {
            sessionID: toolContext.sessionID,
            messageID: toolContext.messageID,
            agent: toolContext.agent,
            directory: ctx.location.directory,
            worktree: ctx.location.project.directory,
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          })
        ) as any,
    } as any)
  );

  await ctx.session.hook("prompt", async (event) => {
    messageIDs.set(event.sessionID, event.messageID);
    const original = { type: "text", text: event.prompt.text };
    const output = { message: { id: event.messageID }, parts: [original] };

    if (memoryContext) {
      try {
        if (!(await memoryContext.capturePrompt({ sessionID: event.sessionID }, output))) {
          suppressed.add(event.sessionID);
          return;
        }
        suppressed.delete(event.sessionID);
        // In V1, the first injected part remains in history. V2 system parts
        // exist only for one request, so retain that context across user turns.
        if (memoryContext.refreshOnPrompt()) contexts.delete(event.sessionID);
        if (!contexts.has(event.sessionID)) {
          contexts.set(event.sessionID, await memoryContext.load(event.sessionID));
        }
      } catch (error) {
        contexts.delete(event.sessionID);
        log("V2 prompt memory context failed", { error: String(error) });
      }
      return;
    }

    contexts.delete(event.sessionID);
    if (!legacy["chat.message"]) return;
    await legacy["chat.message"]({ sessionID: event.sessionID }, output);

    const injected = output.parts
      .filter((part: any) => part !== original && part?.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    if (injected) contexts.set(event.sessionID, injected);
  });

  await ctx.session.hook("context", async (event) => {
    if (memoryContext) {
      if (!memoryContext.enabled()) {
        contexts.clear();
      } else if (!suppressed.has(event.sessionID) && !contexts.has(event.sessionID)) {
        try {
          // Rehydrate from the canonical memory store, without replaying the
          // prompt hook or persisting a second plaintext copy in host storage.
          contexts.set(event.sessionID, await memoryContext.load(event.sessionID));
        } catch (error) {
          log("V2 restored memory context failed", { error: String(error) });
        }
      }
    }
    const injected = suppressed.has(event.sessionID) ? undefined : contexts.get(event.sessionID);
    if (injected) event.system.push({ type: "text", text: injected });

    if (legacy["chat.params"]) {
      await legacy["chat.params"]({
        message: { id: messageIDs.get(event.sessionID) ?? event.sessionID },
        model: { providerID: event.model.providerID, id: event.model.id },
      });
    }
  });

  const controller = new AbortController();
  const watcher = (async () => {
    if (!legacy.event) return;
    try {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        if (await eventBelongsToLocation(ctx, raw)) {
          const event = toLegacyEvent(raw);
          if (event.type === "session.compacted" && event.properties?.sessionID) {
            contexts.delete(event.properties.sessionID);
          }
          await legacy.event({ event });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("opencode-mem event bridge failed", error);
      }
    }
  })();

  return async () => {
    controller.abort();
    await watcher;
    contexts.clear();
    messageIDs.clear();
    suppressed.clear();
    await legacy.dispose?.();
  };
}
