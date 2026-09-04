import { afterEach, describe, expect, it } from "bun:test";
import { MINIMAX_MODEL_METADATA, MiniMaxProvider } from "../src/services/ai/providers/minimax.js";
import { AIProviderFactory } from "../src/services/ai/ai-provider-factory.js";
import type { ChatCompletionTool } from "../src/services/ai/tools/tool-schema.js";

const toolSchema: ChatCompletionTool = {
  type: "function",
  function: {
    name: "save_memories",
    description: "Save memories",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

class FakeSessionManager {
  private readonly session = { id: "session-1" };
  private readonly messages: any[] = [];
  lastCreateSessionArgs: any;

  getSession(sessionId?: string, provider?: string): any {
    void sessionId;
    void provider;
    return null;
  }

  createSession(args: any): any {
    this.lastCreateSessionArgs = args;
    return this.session;
  }

  getMessages(): any[] {
    return this.messages;
  }

  getLastSequence(): number {
    return this.messages.length - 1;
  }

  addMessage(message: any): void {
    this.messages.push(message);
  }
}

function makeProvider(
  overrides: Record<string, unknown> = {},
  sessionManager = new FakeSessionManager()
) {
  return {
    provider: new MiniMaxProvider(
      {
        model: "MiniMax-M3",
        apiUrl: "https://api.minimax.io",
        apiKey: "test-key",
        ...overrides,
      },
      sessionManager as any
    ),
    sessionManager,
  };
}

describe("MiniMaxProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports the minimax provider name", () => {
    const { provider } = makeProvider();
    expect(provider.getProviderName()).toBe("minimax");
    expect(provider.supportsSession()).toBe(true);
  });

  it("resolves the global endpoint at /anthropic/v1/messages", () => {
    const { provider } = makeProvider();
    expect(provider.resolveEndpoint()).toBe("https://api.minimax.io/anthropic/v1/messages");
  });

  it("resolves the China endpoint at api.minimaxi.com", () => {
    const { provider } = makeProvider({ apiUrl: "https://api.minimaxi.com" });
    expect(provider.resolveEndpoint()).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  });

  it("normalizes a base URL that already includes /anthropic/v1", () => {
    const { provider } = makeProvider({ apiUrl: "https://api.minimax.io/anthropic/v1" });
    expect(provider.resolveEndpoint()).toBe("https://api.minimax.io/anthropic/v1/messages");
  });

  it("normalizes a base URL that includes /anthropic", () => {
    const { provider } = makeProvider({ apiUrl: "https://api.minimax.io/anthropic/" });
    expect(provider.resolveEndpoint()).toBe("https://api.minimax.io/anthropic/v1/messages");
  });

  it("normalizes a full /anthropic/v1/messages URL without duplicating the path", () => {
    const { provider } = makeProvider({
      apiUrl: "https://api.minimax.io/anthropic/v1/messages",
    });
    expect(provider.resolveEndpoint()).toBe("https://api.minimax.io/anthropic/v1/messages");
  });

  it("strips a trailing slash from the base URL", () => {
    const { provider } = makeProvider({ apiUrl: "https://api.minimax.io/" });
    expect(provider.resolveEndpoint()).toBe("https://api.minimax.io/anthropic/v1/messages");
  });

  it("throws when memoryApiUrl is not configured", () => {
    const { provider } = makeProvider({ apiUrl: "" });
    expect(() => provider.resolveEndpoint()).toThrow();
  });

  it("records the minimax session provider tag", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "login fail",
      }) as Response) as typeof fetch;

    const { provider, sessionManager } = makeProvider();
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(sessionManager.lastCreateSessionArgs?.provider).toBe("minimax");
  });

  it("targets /anthropic/v1/messages and authenticates with x-api-key", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "login fail",
      } as Response;
    }) as typeof fetch;

    const { provider } = makeProvider();
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedUrl).toBe("https://api.minimax.io/anthropic/v1/messages");
    expect(capturedHeaders?.["x-api-key"]).toBe("test-key");
    expect(capturedHeaders?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("forwards adaptive thinking via memoryExtraParams", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "login fail",
      } as Response;
    }) as typeof fetch;

    const { provider } = makeProvider({
      extraParams: {
        thinking: { type: "adaptive" },
        model: "should-not-overwrite",
        messages: ["should-not-overwrite"],
        tools: ["should-not-overwrite"],
      },
    });
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody?.thinking).toEqual({ type: "adaptive" });
    expect(capturedBody?.model).toBe("MiniMax-M3");
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
    expect(Array.isArray(capturedBody?.tools)).toBe(true);
  });

  it("extracts tool input from a MiniMax Anthropic-format response", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "MiniMax-M3",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "save_memories",
              input: { memory: "captured fact" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      } as Response;
    }) as typeof fetch;

    const { provider } = makeProvider();
    const result = await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody?.model).toBe("MiniMax-M3");
    expect(capturedBody?.max_tokens).toBeDefined();
    expect(result.success).toBe(true);
    expect((result.data as any).memory).toBe("captured fact");
  });
});

describe("MiniMax model metadata", () => {
  it("describes the current models", () => {
    expect(MINIMAX_MODEL_METADATA["MiniMax-M3"]).toEqual({
      contextWindow: 1_000_000,
      pricingUsdPerMillionTokens: {
        input: 0.6,
        output: 2.4,
        cacheRead: 0.12,
        cacheWrite: null,
      },
      inputModalities: ["text", "image", "video"],
      thinkingModes: ["adaptive", "disabled"],
    });
    expect(MINIMAX_MODEL_METADATA["MiniMax-M2.7"]).toEqual({
      contextWindow: 204_800,
      pricingUsdPerMillionTokens: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.06,
        cacheWrite: 0.375,
      },
      inputModalities: ["text"],
      thinkingModes: ["always_on"],
    });
  });
});

describe("AIProviderFactory minimax wiring", () => {
  it("creates a MiniMax provider and lists it as supported", () => {
    const provider = AIProviderFactory.createProvider("minimax", {
      model: "MiniMax-M3",
      apiUrl: "https://api.minimax.io",
      apiKey: "test-key",
    });
    expect(provider.getProviderName()).toBe("minimax");
    expect(AIProviderFactory.getSupportedProviders()).toContain("minimax");
  });
});
