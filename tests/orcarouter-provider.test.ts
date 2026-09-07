import { afterEach, describe, expect, it } from "bun:test";
import {
  OrcaRouterProvider,
  ORCAROUTER_API_URL,
  ORCAROUTER_DEFAULT_MODEL,
} from "../src/services/ai/providers/orcarouter.js";
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
    provider: new OrcaRouterProvider(
      {
        model: "",
        apiUrl: "",
        apiKey: "sk-orca-test",
        ...overrides,
      },
      sessionManager as any
    ),
    sessionManager,
  };
}

describe("OrcaRouterProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports the orcarouter provider name", () => {
    const { provider } = makeProvider();
    expect(provider.getProviderName()).toBe("orcarouter");
    expect(provider.supportsSession()).toBe(true);
  });

  it("defaults to the OrcaRouter gateway endpoint when apiUrl is not configured", () => {
    const { provider } = makeProvider();
    expect(provider.resolveEndpoint()).toBe(ORCAROUTER_API_URL);
  });

  it("strips a trailing slash from a configured apiUrl", () => {
    const { provider } = makeProvider({ apiUrl: "https://proxy.example.com/v1/" });
    expect(provider.resolveEndpoint()).toBe("https://proxy.example.com/v1");
  });

  it("defaults to the orcarouter/auto routing model", () => {
    const { provider } = makeProvider();
    expect(provider.resolveModel()).toBe(ORCAROUTER_DEFAULT_MODEL);
  });

  it("returns a namespaced configured model unchanged", () => {
    const { provider } = makeProvider({ model: "deepseek/deepseek-v4-flash" });
    expect(provider.resolveModel()).toBe("deepseek/deepseek-v4-flash");
  });

  it("rejects a bare model name with a namespacing hint", () => {
    const { provider } = makeProvider({ model: "gpt-4o-mini" });
    expect(() => provider.resolveModel()).toThrow(/namespaced memoryModel/);
  });

  it("records the orcarouter session provider tag", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "login fail",
      }) as Response) as typeof fetch;

    const { provider, sessionManager } = makeProvider();
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(sessionManager.lastCreateSessionArgs?.provider).toBe("orcarouter");
  });

  it("targets /chat/completions on the gateway and authenticates with Bearer", async () => {
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

    expect(capturedUrl).toBe(`${ORCAROUTER_API_URL}/chat/completions`);
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer sk-orca-test");
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

    expect(capturedBody?.model).toBe(ORCAROUTER_DEFAULT_MODEL);
    expect(capturedBody?.tool_choice).toBe("auto");
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
    expect(Array.isArray(capturedBody?.tools)).toBe(true);
  });

  it("extracts tool input from an OpenAI-format response", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
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
      } as Response;
    }) as typeof fetch;

    const { provider } = makeProvider();
    const result = await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody?.model).toBe(ORCAROUTER_DEFAULT_MODEL);
    expect(result.success).toBe(true);
    expect((result.data as any).memory).toBe("captured fact");
  });
});

describe("AIProviderFactory orcarouter wiring", () => {
  it("creates an OrcaRouter provider and lists it as supported", () => {
    const provider = AIProviderFactory.createProvider("orcarouter", {
      model: "",
      apiUrl: "",
      apiKey: "sk-orca-test",
    });
    expect(provider.getProviderName()).toBe("orcarouter");
    expect(AIProviderFactory.getSupportedProviders()).toContain("orcarouter");
  });
});
