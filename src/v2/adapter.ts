import { isAbsolute, resolve } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { log } from "../services/logger.js";
import { onSkillsChanged, skillsManager } from "../services/skills/skills-manager.js";
import { getTags } from "../services/tags.js";
import { extractCompletedFilePath, MAX_OBSERVED_FILES } from "../services/observed-files.js";
import { eventBelongsToLocation, legacyToolResult, toLegacyEvent } from "./legacy-client.js";

interface MemoryContextHooks {
  ownsPendingCaptureSession?(sessionID: string): Promise<boolean>;
  enabled(): boolean;
  refreshOnPrompt(): boolean;
  fileRecallEnabled?(): boolean;
  capturePrompt(
    input: { sessionID: string },
    output: { message: { id: string }; parts: any[] }
  ): Promise<boolean>;
  load(sessionID: string): Promise<string>;
  loadFileContext?(
    sessionID: string,
    filePaths: readonly string[],
    promptMessageID: string,
    baseContext: string
  ): Promise<string>;
}

const MAX_FILE_REFRESHES = 4;

interface FileRecallTurn {
  accepted: boolean;
  active: boolean;
  messageID: string;
  paths: Set<string>;
  pendingCalls: Set<string>;
  attemptedVersion: number;
  refreshes: number;
  baseContext?: string;
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
  const fileTurns = new Map<string, FileRecallTurn>();
  let disposed = false;

  function resetFileTurn(sessionID: string): void {
    const previous = fileTurns.get(sessionID);
    if (previous?.baseContext !== undefined) contexts.set(sessionID, previous.baseContext);
    fileTurns.delete(sessionID);
  }

  function fileRecallEnabled(): boolean {
    return (
      !disposed &&
      ctx.location.workspaceID === undefined &&
      !!memoryContext?.enabled() &&
      !!memoryContext.fileRecallEnabled?.() &&
      !!memoryContext.loadFileContext
    );
  }

  async function refreshFileContext(sessionID: string): Promise<void> {
    const turn = fileTurns.get(sessionID);
    if (!fileRecallEnabled()) {
      if (!disposed && memoryContext?.enabled()) resetFileTurn(sessionID);
      else fileTurns.delete(sessionID);
      return;
    }
    if (
      !turn?.accepted ||
      !turn.active ||
      suppressed.has(sessionID) ||
      turn.paths.size === turn.attemptedVersion ||
      turn.refreshes >= MAX_FILE_REFRESHES
    )
      return;

    const paths = [...turn.paths];
    const version = paths.length;
    // Claim the revision before awaiting: concurrent context hooks must not
    // query the same files twice, including after a failed lookup.
    turn.attemptedVersion = version;
    turn.refreshes++;
    turn.baseContext ??= contexts.get(sessionID) ?? "";
    try {
      const context = await memoryContext!.loadFileContext!(
        sessionID,
        paths,
        turn.messageID,
        turn.baseContext
      );
      if (
        fileRecallEnabled() &&
        fileTurns.get(sessionID) === turn &&
        turn.active &&
        turn.attemptedVersion === version &&
        !suppressed.has(sessionID)
      )
        contexts.set(sessionID, context);
    } catch (error) {
      if (
        fileRecallEnabled() &&
        fileTurns.get(sessionID) === turn &&
        turn.active &&
        turn.attemptedVersion === version
      )
        contexts.set(sessionID, turn.baseContext);
      log("V2 file memory context failed", { error: String(error) });
    }
  }
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

  if (ctx.tool.hook && memoryContext?.fileRecallEnabled) {
    const callKey = (event: { messageID: string; id: string }) => {
      if (
        typeof event.messageID !== "string" ||
        typeof event.id !== "string" ||
        event.messageID.length === 0 ||
        event.id.length === 0 ||
        event.messageID.length > 512 ||
        event.id.length > 512
      )
        return undefined;
      return JSON.stringify([event.messageID, event.id]);
    };
    await ctx.tool.hook("execute.before", async (event) => {
      if (!fileRecallEnabled() || suppressed.has(event.sessionID)) return;
      const turn = fileTurns.get(event.sessionID);
      if (
        !turn?.accepted ||
        !turn.active ||
        turn.pendingCalls.size >= MAX_OBSERVED_FILES ||
        !["read", "edit", "write"].includes(event.tool)
      )
        return;
      const key = callKey(event);
      if (key) turn.pendingCalls.add(key);
    });
    await ctx.tool.hook("execute.after", async (event) => {
      if (!fileRecallEnabled() || suppressed.has(event.sessionID)) return;
      const turn = fileTurns.get(event.sessionID);
      const key = callKey(event);
      if (!key || !turn?.pendingCalls.delete(key)) return;
      if (!turn.accepted || !turn.active || turn.paths.size >= MAX_OBSERVED_FILES) return;
      const path = extractCompletedFilePath(event);
      // This awaited host hook deliberately does no lookup or filesystem I/O.
      // The next primary context boundary processes the bounded observation.
      if (path) {
        turn.paths.add(resolve(ctx.location.directory, path));
      }
    });
  }

  await ctx.session.hook("prompt", async (event) => {
    resetFileTurn(event.sessionID);
    const turn: FileRecallTurn = {
      accepted: false,
      active: false,
      messageID: event.messageID,
      paths: new Set(),
      pendingCalls: new Set(),
      attemptedVersion: 0,
      refreshes: 0,
    };
    const trackedTurn = fileRecallEnabled();
    if (trackedTurn) fileTurns.set(event.sessionID, turn);
    messageIDs.set(event.sessionID, event.messageID);
    const original = { type: "text", text: event.prompt.text };
    const output = { message: { id: event.messageID }, parts: [original] };

    if (memoryContext) {
      try {
        const accepted = await memoryContext.capturePrompt({ sessionID: event.sessionID }, output);
        if (disposed || (trackedTurn && fileTurns.get(event.sessionID) !== turn)) return;
        if (!accepted) {
          suppressed.add(event.sessionID);
          resetFileTurn(event.sessionID);
          return;
        }
        if (fileTurns.get(event.sessionID) === turn) turn.accepted = true;
        suppressed.delete(event.sessionID);
        // In V1, the first injected part remains in history. V2 system parts
        // exist only for one request, so retain that context across user turns.
        if (memoryContext.refreshOnPrompt()) contexts.delete(event.sessionID);
        if (!contexts.has(event.sessionID)) {
          const context = await memoryContext.load(event.sessionID);
          if (!disposed && (!trackedTurn || fileTurns.get(event.sessionID) === turn)) {
            contexts.set(event.sessionID, context);
          }
        }
      } catch (error) {
        if (!trackedTurn || fileTurns.get(event.sessionID) === turn)
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

  await ctx.session.hook("compaction", async (event) => {
    // Do not rely on the asynchronous event bridge to catch up before the next
    // request; recent prompts can remain in a compacted model history. Keep the
    // ordinary first-mode cache until compaction actually completes, since this
    // hook also runs for speculative or failed compaction requests.
    resetFileTurn(event.sessionID);
  });

  await ctx.session.hook("context", async (event) => {
    const turn = fileTurns.get(event.sessionID);
    if (turn) {
      // The prompt hook runs before inbox admission, including queued prompts.
      // Only a prompt actually present in this model request may own new tools.
      turn.active = !!event.messages?.some(
        (message) => message.role === "user" && message.id === turn.messageID
      );
      if (!turn.active) {
        turn.paths.clear();
        turn.pendingCalls.clear();
        turn.attemptedVersion = 0;
        if (turn.baseContext !== undefined) contexts.set(event.sessionID, turn.baseContext);
      }
    }
    if (memoryContext) {
      if (!memoryContext.enabled()) {
        contexts.clear();
      } else if (!suppressed.has(event.sessionID) && !contexts.has(event.sessionID)) {
        try {
          // Rehydrate from the canonical memory store, without replaying the
          // prompt hook or persisting a second plaintext copy in host storage.
          const context = await memoryContext.load(event.sessionID);
          if (!disposed && fileTurns.get(event.sessionID) === turn) {
            contexts.set(event.sessionID, context);
          }
        } catch (error) {
          log("V2 restored memory context failed", { error: String(error) });
        }
      }
    }
    await refreshFileContext(event.sessionID);
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
        if (await eventBelongsToLocation(ctx, raw, memoryContext?.ownsPendingCaptureSession)) {
          const event = toLegacyEvent(raw);
          if (event.type === "session.compacted" && event.properties?.sessionID) {
            fileTurns.delete(event.properties.sessionID);
            contexts.delete(event.properties.sessionID);
          }
          if (event.type === "session.deleted") {
            const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
            fileTurns.delete(sessionID);
            contexts.delete(sessionID);
            messageIDs.delete(sessionID);
            suppressed.delete(sessionID);
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
    disposed = true;
    unsubscribeSkills();
    controller.abort();
    await watcher;
    contexts.clear();
    messageIDs.clear();
    suppressed.clear();
    fileTurns.clear();
    await legacy.dispose?.();
  };
}
