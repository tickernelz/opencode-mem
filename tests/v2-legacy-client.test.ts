import { describe, expect, it } from "bun:test";
import {
  createLegacyClient,
  eventBelongsToLocation,
  legacyToolResult,
  toLegacyEvent,
} from "../src/v2/legacy-client.js";

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    location: {
      directory: "/workspace/project",
      project: { id: "project", directory: "/workspace/project", canonical: "project" },
    },
    // Native v2 context contract: ctx.provider.list() -> { location, data }
    // with ProviderInfo rows (id + activation). The legacy bridge derives
    // connectivity from this directory, not from model.list.
    provider: {
      list: async () => ({
        location: { directory: "/workspace/project" },
        data: [
          { id: "anthropic", name: "Anthropic", activation: "enabled", package: "anthropic" },
          { id: "openai", name: "OpenAI", activation: "enabled", package: "openai" },
        ],
      }),
    },
    model: {
      list: async () => ({
        data: [
          { providerID: "anthropic", id: "claude" },
          { providerID: "anthropic", id: "claude-fast" },
          { providerID: "openai", id: "gpt" },
        ],
      }),
    },
    generate: {
      text: async () => ({ text: '{"summary":"done","tags":["v2"]}' }),
    },
    session: {
      get: async () => ({ id: "ses", location: { directory: "/workspace/project" } }),
      context: async () => [],
      synthetic: async (input: unknown) => input,
      prompt: async (input: unknown) => input,
      interrupt: async () => ({ interrupted: true }),
    },
    ...overrides,
  } as any;
}

describe("OpenCode v2 legacy client bridge", () => {
  it("reports providers with active models from the provider directory", async () => {
    // Connectivity comes from ctx.provider.list() (activation auto/enabled);
    // model.list is no longer the source (broker 'opencode' hid real ids).
    // model.list throws here if ever consulted.
    const ctx = createContext({
      model: {
        list: async () => {
          throw new Error("model.list must not be called");
        },
      },
    });
    const client = createLegacyClient(ctx);
    const result = await client.provider.list();
    expect(result.data.connected).toEqual(["anthropic", "openai"]);
  });

  it("preserves create/prompt/delete structured-output semantics", async () => {
    let generationInput: any;
    const ctx = createContext({
      generate: {
        text: async (input: any) => {
          generationInput = input;
          return { text: '```json\n{"summary":"done","tags":["v2"]}\n```' };
        },
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    const result = await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      system: "Summarize the work.",
      parts: [{ type: "text", text: "Implemented OpenCode v2." }],
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { summary: { type: "string" }, tags: { type: "array" } },
          required: ["summary", "tags"],
        },
      },
    });

    expect(generationInput.model).toEqual({ providerID: "anthropic", id: "claude" });
    expect(generationInput.prompt).toContain("Return only one JSON object");
    expect(generationInput.prompt).toContain('"required":["summary","tags"]');
    expect(result.data.info.structured_output).toEqual({
      summary: "done",
      tags: ["v2"],
    });
    expect((await client.session.delete({ sessionID })).data).toBe(true);
  });

  it("forwards the prompt body variant into ctx.generate.text model and omits it when unset", async () => {
    const generationInputs: any[] = [];
    const ctx = createContext({
      generate: {
        text: async (input: any) => {
          generationInputs.push(input);
          return { text: '{"summary":"done","tags":["v2"]}' };
        },
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    const promptArgs = (variant?: string) => ({
      sessionID,
      ...(variant ? { variant } : {}),
      model: { providerID: "newapi", modelID: "grok-4.7" },
      system: "Summarize the work.",
      parts: [{ type: "text", text: "Implemented variant plumbing." }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      },
    });

    await client.session.prompt(promptArgs("xhigh"));
    await client.session.prompt(promptArgs());

    expect(generationInputs[0].model).toEqual({
      providerID: "newapi",
      id: "grok-4.7",
      variant: "xhigh",
    });
    expect(generationInputs[1].model).toEqual({ providerID: "newapi", id: "grok-4.7" });
    expect("variant" in generationInputs[1].model).toBe(false);
    await client.session.delete({ sessionID });
  });

  it("json_schema prompts state that no tools are available and only JSON may be returned", async () => {
    let generationPrompt = "";
    const ctx = createContext({
      generate: {
        text: async (input: any) => {
          generationPrompt = input.prompt;
          return { text: '{"summary":"done","tags":["v2"]}' };
        },
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      system: "Use the update_user_profile tool to save the new profile.",
      parts: [{ type: "text", text: "Analyze these prompts." }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      },
    });

    // The v2 Generate API has no tools; the instruction must come after the
    // system/user text and forbid tool use so obedient models answer with JSON.
    expect(generationPrompt).toContain("No tools are available");
    expect(generationPrompt.indexOf("No tools are available")).toBeGreaterThan(
      generationPrompt.indexOf("Analyze these prompts.")
    );
    expect(generationPrompt).toContain("only the JSON object");
    await client.session.delete({ sessionID });
  });

  it("text prompts without a json_schema format stay unchanged", async () => {
    let generationPrompt = "";
    const ctx = createContext({
      generate: {
        text: async (input: any) => {
          generationPrompt = input.prompt;
          return { text: "ok" };
        },
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      system: "Summarize the work.",
      parts: [{ type: "text", text: "Implemented OpenCode v2." }],
    });

    expect(generationPrompt).not.toContain("no tools are available");
    expect(generationPrompt).toContain("Summarize the work.");
    await client.session.delete({ sessionID });
  });

  it("recovers structured output from a fenced ```json block after leading prose", async () => {
    const ctx = createContext({
      generate: {
        text: async () => ({
          text: 'I\'ll analyze these prompts first.\n\n```json\n{"summary":"done","tags":["v2"]}\n```\n\nDone.',
        }),
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    const result = await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      parts: [{ type: "text", text: "Analyze." }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      },
    });

    expect(result.data.info.structured_output).toEqual({
      summary: "done",
      tags: ["v2"],
    });
    await client.session.delete({ sessionID });
  });

  it("recovers structured output from leading prose without fences", async () => {
    const ctx = createContext({
      generate: {
        text: async () => ({
          text: 'Let me load the profile update tool first.\n\n{"summary":"done","tags":["v2"]}',
        }),
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    const result = await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      parts: [{ type: "text", text: "Analyze." }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      },
    });

    expect(result.data.info.structured_output).toEqual({
      summary: "done",
      tags: ["v2"],
    });
    await client.session.delete({ sessionID });
  });

  it("recovers the last balanced top-level object when several are present", async () => {
    const ctx = createContext({
      generate: {
        text: async () => ({
          text: 'Preamble {"summary":"stub","tags":["example"]} {"summary":"done","tags":["v2"]}',
        }),
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    const result = await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      parts: [{ type: "text", text: "Analyze." }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      },
    });

    expect(result.data.info.structured_output).toEqual({
      summary: "done",
      tags: ["v2"],
    });
    await client.session.delete({ sessionID });
  });

  it("skips an unparseable balanced span and recovers a later object", async () => {
    const ctx = createContext({
      generate: {
        text: async () => ({
          text: 'Bad {summary: broken} then {"summary":"done","tags":["v2"]}',
        }),
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    const result = await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      parts: [{ type: "text", text: "Analyze." }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      },
    });

    expect(result.data.info.structured_output).toEqual({
      summary: "done",
      tags: ["v2"],
    });
    await client.session.delete({ sessionID });
  });

  it("still yields no structured output when the reply is garbage", async () => {
    const ctx = createContext({
      generate: {
        text: async () => ({ text: "I cannot answer that in JSON, sorry." }),
      },
    });
    const client = createLegacyClient(ctx);

    const created = await client.session.create({ title: "capture" });
    const sessionID = created.data.id;
    const result = await client.session.prompt({
      sessionID,
      model: { providerID: "anthropic", modelID: "claude" },
      parts: [{ type: "text", text: "Analyze." }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      },
    });

    expect(result.data.info.structured_output).toBeUndefined();
    expect(result.data.info.structured).toBeUndefined();
    await client.session.delete({ sessionID });
  });

  it("maps V1 noReply prompts to V2 synthetic messages", async () => {
    let syntheticInput: any;
    const ctx = createContext({
      session: {
        ...createContext().session,
        synthetic: async (input: any) => {
          syntheticInput = input;
          return input;
        },
      },
    });
    const client = createLegacyClient(ctx);
    await client.session.prompt({
      path: { id: "ses-1" },
      body: {
        noReply: true,
        parts: [{ type: "text", text: "restored memory", metadata: { source: "memory" } }],
      },
    });

    expect(syntheticInput).toEqual({
      sessionID: "ses-1",
      text: "restored memory",
      description: "memory context",
      metadata: { source: "memory" },
    });
  });

  it("maps released V2 compaction events to the V1 handler name", () => {
    expect(
      toLegacyEvent({
        type: "session.compaction.ended",
        data: { sessionID: "ses-1" },
      })
    ).toEqual({
      type: "session.compacted",
      properties: { sessionID: "ses-1" },
    });
  });

  it("aliases v2 execution events to session.idle", () => {
    const t = (raw: string) => toLegacyEvent({ type: raw, data: { sessionID: "s1" } }).type;

    expect(t("session.execution.succeeded")).toBe("session.idle");
    expect(t("session.execution.failed")).toBe("session.idle");
    expect(t("session.execution.interrupted")).toBe("session.idle");
    expect(t("session.compaction.ended")).toBe("session.compacted");
    expect(t("message.updated")).toBe("message.updated");
    expect(t("session.execution.succeeded.1")).toBe("session.idle");
  });

  it("filters the global event stream by direct or session location", async () => {
    const ctx = createContext();
    expect(
      await eventBelongsToLocation(ctx, {
        location: { directory: "/workspace/project" },
        data: { sessionID: "ses-1" },
      })
    ).toBe(true);
    expect(
      await eventBelongsToLocation(ctx, {
        location: { directory: "/workspace/other" },
        data: { sessionID: "ses-1" },
      })
    ).toBe(false);
    expect(
      await eventBelongsToLocation(ctx, {
        data: { sessionID: "ses-1" },
      })
    ).toBe(true);
  });

  it("forwards process-scoped provider/model inventory events without location", async () => {
    const ctx = createContext();
    expect(await eventBelongsToLocation(ctx, { type: "provider.updated", data: {} })).toBe(true);
    expect(await eventBelongsToLocation(ctx, { type: "model.updated", data: {} })).toBe(true);
    expect(
      await eventBelongsToLocation(ctx, {
        payload: { type: "provider.updated", data: {} },
      })
    ).toBe(true);
    // Still location-scoped when the host does attach a directory.
    expect(
      await eventBelongsToLocation(ctx, {
        type: "provider.updated",
        location: { directory: "/workspace/other" },
        data: {},
      })
    ).toBe(false);
    // Unrelated events without location/session stay filtered out.
    expect(await eventBelongsToLocation(ctx, { type: "session.idle", data: {} })).toBe(false);
  });

  it("normalizes legacy tool results", () => {
    expect(legacyToolResult("ok")).toEqual({ content: "ok" });
    expect(legacyToolResult({ output: "done", metadata: { count: 1 } })).toEqual({
      content: "done",
      metadata: { count: 1 },
    });
  });

  it("emits toast intents over the RPC bridge when registered", async () => {
    const emitted: Array<{ name: string; data: unknown }> = [];
    const toastRpc = {
      events: {
        emit: async (name: "toast", data: unknown) => {
          emitted.push({ name, data });
        },
      },
    };
    const client = createLegacyClient(createContext(), toastRpc);

    const result = await client.tui.showToast({
      body: {
        title: "Memory Captured",
        message: "Project memory saved from conversation",
        variant: "success",
        duration: 3000,
      },
    });

    expect(result).toEqual({ data: true });
    expect(emitted).toEqual([
      {
        name: "toast",
        data: {
          title: "Memory Captured",
          message: "Project memory saved from conversation",
          variant: "success",
          duration: 3000,
        },
      },
    ]);
  });

  it("falls back to console when no toast RPC registration is provided", async () => {
    const client = createLegacyClient(createContext());
    const result = await client.tui.showToast({
      body: {
        title: "Memory Captured",
        message: "Project memory saved from conversation",
        variant: "success",
      },
    });
    expect(result).toEqual({ data: false });
  });

  it("falls back to console when toast RPC emit fails", async () => {
    const toastRpc = {
      events: {
        emit: async () => {
          throw new Error("rpc unavailable");
        },
      },
    };
    const client = createLegacyClient(createContext(), toastRpc);
    const result = await client.tui.showToast({
      body: {
        title: "Auto Capture Failed",
        message: "timeout",
        variant: "error",
      },
    });
    expect(result).toEqual({ data: false });
  });
});

describe("buffered capture evidence after session deletion", () => {
  it("normalizes v2 terminal event versions and sync envelopes", () => {
    expect(
      toLegacyEvent({
        type: "sync",
        syncEvent: { type: "session.tool.success.2", data: { sessionID: "s" } },
      })
    ).toEqual({ type: "session.tool.success", properties: { sessionID: "s" } });
  });
  it("uses pending project ownership only for recognized evidence events after lookup failure", async () => {
    const ctx = {
      location: { directory: "/project" },
      session: {
        get: async () => {
          throw new Error("gone");
        },
      },
    } as any;
    const own = async (id: string) => id === "ours";
    expect(
      await eventBelongsToLocation(
        ctx,
        { type: "session.text.ended.1", data: { sessionID: "ours" } },
        own
      )
    ).toBe(true);
    expect(
      await eventBelongsToLocation(
        ctx,
        { type: "session.text.ended.1", data: { sessionID: "other" } },
        own
      )
    ).toBe(false);
    expect(
      await eventBelongsToLocation(
        ctx,
        { type: "session.permissions.1", data: { sessionID: "ours" } },
        own
      )
    ).toBe(false);
    expect(
      await eventBelongsToLocation(
        ctx,
        { directory: "/other", type: "session.text.ended.1", data: { sessionID: "ours" } },
        own
      )
    ).toBe(false);
    expect(
      await eventBelongsToLocation(
        ctx,
        { type: "message.part.updated", properties: { part: { sessionID: "ours" } } },
        own
      )
    ).toBe(true);
  });
});
