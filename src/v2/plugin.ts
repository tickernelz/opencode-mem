import type { Plugin } from "@opencode/plugin/promise/plugin";
import { OpenCodeMemPlugin } from "../index.js";
import {
  createLegacyClient,
  eventBelongsToLocation,
  legacyToolResult,
  toLegacyEvent,
} from "./legacy-client.js";

const memoryInput = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["add", "search", "profile", "list", "forget", "help", "migrate", "list-shards", "export", "import"] },
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

const OpenCodeMemPluginV2: Plugin = {
  id: "opencode-mem",
  async setup(ctx) {
    const legacy = await OpenCodeMemPlugin({
      client: createLegacyClient(ctx),
      directory: ctx.location.directory,
      worktree: ctx.location.project.directory,
      project: ctx.location.project,
      serverUrl: undefined,
    } as any) as any;
    const contexts = new Map<string, string>();
    const messageIDs = new Map<string, string>();

    await ctx.tool.transform((editor) => editor.add({
      name: "memory",
      description: legacy.tool.memory.description,
      input: memoryInput as any,
      execute: async (args: any, toolContext: any) => legacyToolResult(await legacy.tool.memory.execute(args, {
        sessionID: toolContext.sessionID,
        messageID: toolContext.messageID,
        agent: toolContext.agent,
        directory: ctx.location.directory,
        worktree: ctx.location.project.directory,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      })) as any,
    } as any));

    await ctx.session.hook("prompt", async (event) => {
      messageIDs.set(event.sessionID, event.messageID);
      contexts.delete(event.sessionID);
      if (!legacy["chat.message"]) return;
      const original = { type: "text", text: event.prompt.text };
      const output = { message: { id: event.messageID }, parts: [original] };
      await legacy["chat.message"]({ sessionID: event.sessionID }, output);
      const injected = output.parts
        .filter((part: any) => part !== original && part?.type === "text")
        .map((part: any) => part.text)
        .join("\n");
      if (injected) contexts.set(event.sessionID, injected);
    });

    await ctx.session.hook("context", async (event) => {
      const injected = contexts.get(event.sessionID);
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
            await legacy.event({ event: toLegacyEvent(raw) });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("opencode-mem event bridge failed", error);
      }
    })();

    return async () => {
      controller.abort();
      await watcher;
      await legacy.dispose?.();
    };
  },
};

export default OpenCodeMemPluginV2;
