import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureOpencodeHostTransport, isStructuredSummaryPromptMessage } from "../src/index.js";
import { getHostClientConfig } from "../src/services/ai/opencode-host-config.js";
import {
  createV2Client,
  generateStructuredOutput,
  resetHostFetch,
  setHostFetch,
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

  it("does not filter ordinary user messages", () => {
    expect(isStructuredSummaryPromptMessage("Analyze this conversation in the bug report.")).toBe(
      false
    );
  });
});
