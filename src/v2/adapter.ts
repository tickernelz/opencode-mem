import { isAbsolute, resolve } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { log } from "../services/logger.js";
import { onSkillsChanged, skillsManager } from "../services/skills/skills-manager.js";
import { getTags } from "../services/tags.js";
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
  /** Skill IDs last registered from opencode-mem DB (so we can remove stale ones). */
  const registeredSkillIds = new Set<string>();

  async function registerDbSkills(): Promise<void> {
    if (!ctx.skill?.transform) return;

    const projectTag = getTags(ctx.location.directory).project.tag;
    let skills: Awaited<ReturnType<typeof skillsManager.list>> = [];
    try {
      skills = await skillsManager.list({
        enabledOnly: true,
        containerTag: projectTag,
      });
    } catch (error) {
      log("Failed to load skills for OpenCode registration", { error: String(error) });
      return;
    }

    const nextIds = new Set(skills.map((skill) => skill.id));

    await ctx.skill.transform((editor) => {
      for (const id of registeredSkillIds) {
        if (!nextIds.has(id) && editor.get(id)) {
          editor.remove(id);
        }
      }

      for (const skill of skills) {
        const path = skillsManager.skillPath(skill.id);
        const absolutePath = isAbsolute(path) ? path : resolve(path);
        const payload = {
          id: skill.id,
          name: skill.name,
          description: skill.description || undefined,
          autoinvoke: skill.autoinvoke,
          path: absolutePath,
          content: skill.content,
        } as any;

        if (editor.get(skill.id)) {
          editor.update(skill.id, (entry) => {
            entry.name = payload.name;
            entry.description = payload.description;
            entry.autoinvoke = payload.autoinvoke;
            entry.path = payload.path;
            entry.content = payload.content;
          });
        } else {
          editor.add(payload);
        }
      }
    });

    registeredSkillIds.clear();
    for (const id of nextIds) registeredSkillIds.add(id);
  }

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

  await registerDbSkills();
  const unsubscribeSkills = onSkillsChanged(() => {
    void (async () => {
      try {
        await registerDbSkills();
        await ctx.skill?.reload?.();
      } catch (error) {
        log("Failed to reload OpenCode skills after DB change", { error: String(error) });
      }
    })();
  });

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
    unsubscribeSkills();
    controller.abort();
    await watcher;
    contexts.clear();
    messageIDs.clear();
    suppressed.clear();
    await legacy.dispose?.();
  };
}
