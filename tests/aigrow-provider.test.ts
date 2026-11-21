import { afterEach, describe, expect, it } from "bun:test";
import {
  AigrowProvider,
  AIGROW_API_URL,
  AIGROW_DEFAULT_MODEL,
} from "../src/services/ai/providers/aigrow.js";
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
    provider: new AigrowProvider(
      {
        model: "",
        apiUrl: "",
        apiKey: "aigrow-test-key",
        ...overrides,
      },
      sessionManager as any
    ),
    sessionManager,
  };
}

describe("AigrowProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports the aigrow provider name", () => {
    const { provider } = makeProvider();
    expect(provider.getProviderName()).toBe("aigrow");
    expect(provider.supportsSession()).toBe(true);
  });

  it("defaults to the AIGROW endpoint when apiUrl is not configured", () => {
    const { provider } = makeProvider();
    expect(provider.resolveEndpoint()).toBe(AIGROW_API_URL);
  });

  it("strips a trailing slash from a configured apiUrl", () => {
    const { provider } = makeProvider({ apiUrl: "https://proxy.example.com/v1/" });
    expect(provider.resolveEndpoint()).toBe("https://proxy.example.com/v1");
  });

  it("defaults to claude-haiku-5.5", () => {
    const { provider } = makeProvider();
    expect(provider.resolveModel()).toBe(AIGROW_DEFAULT_MODEL);
  });

  it("returns a configured model unchanged", () => {
    const { provider } = makeProvider({ model: "gpt-6.2-sol" });
    expect(provider.resolveModel()).toBe("gpt-6.2-sol");
  });

  it("records the aigrow session provider tag", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "login fail",
      }) as Response) as typeof fetch;

    const { provider, sessionManager } = makeProvider();
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(sessionManager.lastCreateSessionArgs?.provider).toBe("aigrow");
  });

  it("targets /chat/completions on AIGROW and authenticates with Bearer", async () => {
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

    expect(capturedUrl).toBe(`${AIGROW_API_URL}/chat/completions`);
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer aigrow-test-key");
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

    expect(capturedBody?.model).toBe(AIGROW_DEFAULT_MODEL);
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

describe("AIProviderFactory aigrow wiring", () => {
  it("creates an AIGROW provider and lists it as supported", () => {
    const provider = AIProviderFactory.createProvider("aigrow", {
      model: "",
      apiUrl: "",
      apiKey: "aigrow-test-key",
    });
    expect(provider).toBeInstanceOf(AigrowProvider);
    expect(provider.getProviderName()).toBe("aigrow");
    expect(AIProviderFactory.getSupportedProviders()).toContain("aigrow");
  });
});
