import { describe, expect, it } from "bun:test";
import { registerV2Adapter } from "../src/v2/adapter.js";

describe("OpenCode v2 plugin adapter", () => {
  it("invalidates the compacted session's cache only for events at this location", async () => {
    const hooks = new Map<string, (event: any) => Promise<void>>();
    let nextEvent!: (event: any) => void;
    let handled!: () => void;
    let revision = 1;
    const ctx = {
      location: { directory: "/workspace/project" },
      tool: { transform: async () => {} },
      session: {
        hook: async (name: string, callback: (event: any) => Promise<void>) => {
          hooks.set(name, callback);
        },
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          while (!signal.aborted) {
            const event = await new Promise<any>((resolve) => {
              nextEvent = resolve;
              signal.addEventListener("abort", () => resolve(null), { once: true });
            });
            if (event) yield event;
            handled();
          }
        },
      },
    } as any;
    const cleanup = await registerV2Adapter(ctx, {
      tool: { memory: { description: "memory" } },
      memoryContext: {
        enabled: () => true,
        refreshOnPrompt: () => false,
        capturePrompt: async () => true,
        load: async (sessionID: string) => sessionID + "-" + revision,
      },
      event: async () => {},
    });
    async function context(sessionID: string) {
      const event = { sessionID, model: {}, system: [] as any[] };
      await hooks.get("context")!(event);
      return event.system.map((part) => part.text);
    }
    async function compact(directory: string) {
      const completed = new Promise<void>((resolve) => {
        handled = resolve;
      });
      nextEvent({
        type: "session.compaction.ended",
        location: { directory },
        data: { sessionID: "ses-1" },
      });
      await completed;
    }
    expect(await context("ses-1")).toEqual(["ses-1-1"]);
    expect(await context("ses-2")).toEqual(["ses-2-1"]);
    revision++;
    await compact("/other/project");
    expect(await context("ses-1")).toEqual(["ses-1-1"]);
    await compact("/workspace/project");
    expect(await context("ses-1")).toEqual(["ses-1-2"]);
    expect(await context("ses-2")).toEqual(["ses-2-1"]);
    await cleanup();
  });

  it("registers the tool and bridges prompt, context, model, events, and cleanup", async () => {
    const hooks = new Map<string, (event: any) => Promise<void>>();
    let tool: any;
    let modelInput: any;
    let eventInput: any;
    let disposed = false;
    let resolveEvent!: () => void;
    const eventHandled = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });

    const ctx = {
      location: {
        directory: "/workspace/project",
        project: { id: "project", directory: "/workspace/project", canonical: "project" },
      },
      tool: {
        transform: async (callback: (editor: any) => void) => {
          callback({ add: (definition: any) => (tool = definition) });
        },
      },
      session: {
        hook: async (name: string, callback: (event: any) => Promise<void>) => {
          hooks.set(name, callback);
        },
        get: async () => ({ location: { directory: "/workspace/project" } }),
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          yield {
            type: "session.idle",
            location: { directory: "/workspace/project" },
            data: { sessionID: "ses-1" },
          };
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        },
      },
    } as any;

    const legacy = {
      tool: {
        memory: {
          description: "Memory tool",
          execute: async (args: any) => JSON.stringify({ success: true, args }),
        },
      },
      "chat.message": async (_input: any, output: any) => {
        output.parts.unshift({ type: "text", text: "remembered context", synthetic: true });
      },
      "chat.params": async (input: any) => {
        modelInput = input;
      },
      event: async (input: any) => {
        eventInput = input;
        resolveEvent();
      },
      dispose: async () => {
        disposed = true;
      },
    };

    const cleanup = await registerV2Adapter(ctx, legacy);

    expect(tool.name).toBe("memory");
    expect(
      JSON.parse(
        (
          await tool.execute(
            { mode: "help" },
            {
              sessionID: "ses-1",
              messageID: "msg-1",
              agent: "build",
            }
          )
        ).content
      )
    ).toEqual({ success: true, args: { mode: "help" } });

    await hooks.get("prompt")?.({
      sessionID: "ses-1",
      messageID: "msg-1",
      prompt: { text: "Implement V2" },
    });
    const contextEvent = {
      sessionID: "ses-1",
      model: { providerID: "anthropic", id: "claude" },
      system: [] as Array<{ type: string; text: string }>,
    };
    await hooks.get("context")?.(contextEvent);

    expect(contextEvent.system).toEqual([{ type: "text", text: "remembered context" }]);
    expect(modelInput).toEqual({
      message: { id: "msg-1" },
      model: { providerID: "anthropic", id: "claude" },
    });

    await eventHandled;
    expect(eventInput).toEqual({
      event: { type: "session.idle", properties: { sessionID: "ses-1" } },
    });

    await cleanup();
    expect(disposed).toBe(true);
  });
});
