import { afterEach, describe, expect, it } from "bun:test";
import {
  UberLLMProvider,
  UBERLLM_API_URL,
  UBERLLM_DEFAULT_MODEL,
} from "../src/services/ai/providers/uberllm.js";
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
    provider: new UberLLMProvider(
      {
        model: "",
        apiUrl: "",
        apiKey: "uberllm-test-key",
        ...overrides,
      },
      sessionManager as any
    ),
    sessionManager,
  };
}

describe("UberLLMProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports the uberllm provider name", () => {
    const { provider } = makeProvider();
    expect(provider.getProviderName()).toBe("uberllm");
    expect(provider.supportsSession()).toBe(true);
  });

  it("defaults to the UberLLM endpoint when apiUrl is not configured", () => {
    const { provider } = makeProvider();
    expect(provider.resolveEndpoint()).toBe(UBERLLM_API_URL);
  });

  it("strips a trailing slash from a configured apiUrl", () => {
    const { provider } = makeProvider({ apiUrl: "https://proxy.example.com/v1/" });
    expect(provider.resolveEndpoint()).toBe("https://proxy.example.com/v1");
  });

  it("defaults to deepseek/deepseek-v4-flash", () => {
    const { provider } = makeProvider();
    expect(provider.resolveModel()).toBe(UBERLLM_DEFAULT_MODEL);
  });

  it("returns a configured model unchanged", () => {
    const { provider } = makeProvider({ model: "openai/gpt-5.4-mini" });
    expect(provider.resolveModel()).toBe("openai/gpt-5.4-mini");
  });

  it("records the uberllm session provider tag", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "login fail",
      }) as Response) as typeof fetch;

    const { provider, sessionManager } = makeProvider();
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(sessionManager.lastCreateSessionArgs?.provider).toBe("uberllm");
  });

  it("targets /chat/completions on UberLLM and authenticates with Bearer", async () => {
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

    expect(capturedUrl).toBe(`${UBERLLM_API_URL}/chat/completions`);
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer uberllm-test-key");
  });

  it("sends the resolved default model in the request body", async () => {
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

    const { provider } = makeProvider();
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody?.model).toBe(UBERLLM_DEFAULT_MODEL);
    expect(capturedBody?.tool_choice).toBe("required");
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
    expect(Array.isArray(capturedBody?.tools)).toBe(true);
  });

  it("extracts tool input from an OpenAI-format response", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "save_memories",
                      arguments: JSON.stringify({ memory: "captured fact" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      }) as Response) as typeof fetch;

    const { provider } = makeProvider();
    const result = await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(result.success).toBe(true);
    expect((result.data as any).memory).toBe("captured fact");
  });
});

describe("AIProviderFactory uberllm wiring", () => {
  it("creates an UberLLM provider and lists it as supported", () => {
    const provider = AIProviderFactory.createProvider("uberllm", {
      model: "",
      apiUrl: "",
      apiKey: "uberllm-test-key",
    });
    expect(provider).toBeInstanceOf(UberLLMProvider);
    expect(provider.getProviderName()).toBe("uberllm");
    expect(AIProviderFactory.getSupportedProviders()).toContain("uberllm");
  });
});
