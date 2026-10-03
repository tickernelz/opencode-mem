import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyStructuredOutputAgentConfig,
  applyStructuredOutputChatParams,
  configureOpencodeHostTransport,
  INTERNAL_CAPTURE_SESSION_TITLE,
  isInternalCaptureSessionTitle,
  isStructuredSummaryPromptMessage,
} from "../src/index.js";
import { getHostClientConfig } from "../src/services/ai/opencode-host-config.js";
import {
  createV2Client,
  generateStructuredOutput,
  resetHostFetch,
  setHostFetch,
  STRUCTURED_OUTPUT_AGENT,
  STRUCTURED_OUTPUT_TOOLS,
} from "../src/services/ai/opencode-provider.js";
import { z } from "zod";

function sdkService(config: Record<string, unknown>): Record<string, unknown> {
  return {
    _client: {
      getConfig: () => config,
    },
  };
}

function pluginInput(client: Record<string, unknown>): {
  readonly client: Record<string, unknown>;
} {
  return {
    client,
  };
}

describe("OpenCode host client config", () => {
  it("extracts host fetch from nested SDK service clients", () => {
    const hostFetch = globalThis.fetch;
    const ctx = pluginInput({
      session: sdkService({ baseUrl: "http://localhost:4096", fetch: hostFetch }),
      provider: { list: async () => ({ data: { connected: [] } }) },
    });

    expect(getHostClientConfig(ctx)).toEqual({
      baseUrl: "http://localhost:4096",
      fetch: hostFetch,
      clientKeys: ["session", "provider"],
      sdkConfigCount: 1,
    });
  });

  it("extracts host default headers from nested SDK service clients", () => {
    const ctx = pluginInput({
      session: sdkService({
        baseUrl: "http://localhost:4096",
        headers: { Authorization: "Basic test-credential" },
      }),
    });

    expect(getHostClientConfig(ctx).headers).toEqual({
      Authorization: "Basic test-credential",
    });
  });

  it("resets stale host fetch and logs when SDK config reflection finds no host fetch", async () => {
    const globalFetch = globalThis.fetch;
    const logFile = join(mkdtempSync(join(tmpdir(), "opencode-mem-test-")), "opencode-mem.log");
    process.env.OPENCODE_MEM_LOG_FILE = logFile;
    const calls: string[] = [];

    const staleHostFetch: typeof fetch = Object.assign(
      async () => {
        throw new TypeError("stale host fetch should not be used");
      },
      { preconnect: globalFetch.preconnect }
    );
    const fallbackFetch: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        calls.push(`${req.method.toUpperCase()} ${req.url}`);

        if (req.method === "POST" && req.url.endsWith("/session")) {
          return new Response(JSON.stringify({ id: "ses_global_fetch" }));
        }
        if (req.method === "POST" && req.url.includes("/session/ses_global_fetch/message")) {
          return new Response(
            JSON.stringify({
              info: { structured_output: { topic: "fallback", count: 1 } },
              parts: [],
            })
          );
        }
        return new Response(JSON.stringify(true));
      },
      { preconnect: globalFetch.preconnect }
    );

    setHostFetch(staleHostFetch);
    globalThis.fetch = fallbackFetch;

    try {
      await configureOpencodeHostTransport({
        client: { provider: { list: async () => ({ data: { connected: [] } }) } },
        serverUrl: "http://localhost:4096",
      });

      const result = await generateStructuredOutput({
        client: createV2Client("http://localhost:4096"),
        providerID: "openai",
        modelID: "gpt-5.5",
        systemPrompt: "s",
        userPrompt: "u",
        schema: z.object({ topic: z.string(), count: z.number() }),
      });

      expect(result).toEqual({ topic: "fallback", count: 1 });
      expect(calls.map((call) => call.split(" ")[0])).toEqual(["POST", "POST", "DELETE"]);
      expect(readFileSync(logFile, "utf-8")).toContain(
        "OpenCode host fetch unavailable; falling back to global fetch"
      );
    } finally {
      globalThis.fetch = globalFetch;
      resetHostFetch();
      delete process.env.OPENCODE_MEM_LOG_FILE;
    }
  });
});

describe("structured summary prompt filter", () => {
  it("identifies the plugin's own structured-summary prompt echo", () => {
    expect(
      isStructuredSummaryPromptMessage(
        'Analyze this conversation. Return type="skip" for no memory.'
      )
    ).toBe(true);
  });

  it("identifies the plugin's own user-profile analysis prompt echo", () => {
    expect(
      isStructuredSummaryPromptMessage(
        "# User Profile Analysis\n\nAnalyze 10 user prompts to update the user profile."
      )
    ).toBe(true);
  });

  it("does not filter ordinary user messages", () => {
    expect(isStructuredSummaryPromptMessage("Analyze this conversation in the bug report.")).toBe(
      false
    );
    expect(isStructuredSummaryPromptMessage("Please update my user profile preferences.")).toBe(
      false
    );
  });
});

describe("internal capture session title", () => {
  it("matches the transient structured-output session title", () => {
    expect(isInternalCaptureSessionTitle(INTERNAL_CAPTURE_SESSION_TITLE)).toBe(true);
    expect(isInternalCaptureSessionTitle("opencode-mem capture")).toBe(true);
  });

  it("does not match ordinary session titles", () => {
    expect(isInternalCaptureSessionTitle("My coding session")).toBe(false);
    expect(isInternalCaptureSessionTitle("")).toBe(false);
    expect(isInternalCaptureSessionTitle(undefined)).toBe(false);
    expect(isInternalCaptureSessionTitle(null)).toBe(false);
  });
});

describe("structured-output agent config (issue #189)", () => {
  it("registers a step-capped least-privilege agent", () => {
    const cfg: { agent?: Record<string, unknown> } = {
      agent: { build: { mode: "primary" } },
    };
    applyStructuredOutputAgentConfig(cfg);

    expect(cfg.agent?.build).toEqual({ mode: "primary" });
    expect(cfg.agent?.[STRUCTURED_OUTPUT_AGENT]).toEqual({
      description: "Internal least-privilege agent for opencode-mem structured output",
      mode: "subagent",
      steps: 2,
      maxSteps: 2,
      tools: STRUCTURED_OUTPUT_TOOLS,
      permission: {
        "*": "deny",
        StructuredOutput: "allow",
      },
      options: {
        thinking: { type: "disabled" },
      },
    });
  });
});

describe("structured-output chat.params thinking disable (issue #253)", () => {
  it("forces thinking disabled after variant merge for the structured agent", () => {
    const output = {
      options: {
        reasoningEffort: "high",
        thinking: { type: "enabled" },
      },
    };

    applyStructuredOutputChatParams({ agent: STRUCTURED_OUTPUT_AGENT }, output);

    expect(output.options).toEqual({
      reasoningEffort: "high",
      thinking: { type: "disabled" },
    });
  });

  it("does not mutate options for ordinary agents", () => {
    const output = {
      options: {
        reasoningEffort: "high",
      },
    };

    applyStructuredOutputChatParams({ agent: "build" }, output);

    expect(output.options).toEqual({ reasoningEffort: "high" });
  });

  it("ignores missing output", () => {
    expect(() =>
      applyStructuredOutputChatParams({ agent: STRUCTURED_OUTPUT_AGENT }, undefined)
    ).not.toThrow();
  });
});
