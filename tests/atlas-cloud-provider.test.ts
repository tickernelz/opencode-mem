import { afterEach, describe, expect, it } from "bun:test";
import {
  AtlasCloudProvider,
  ATLAS_CLOUD_API_URL,
  ATLAS_CLOUD_DEFAULT_MODEL,
} from "../src/ai/providers/atlas-cloud.js";
import { AIProviderFactory } from "../src/ai/ai-provider-factory.js";
import type { ChatCompletionTool } from "../src/ai/tools/tool-schema.js";

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
    provider: new AtlasCloudProvider(
      {
        model: "",
        apiUrl: "",
        apiKey: "atlas-test-key",
        ...overrides,
      },
      sessionManager as any
    ),
    sessionManager,
  };
}

describe("AtlasCloudProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports the atlas-cloud provider name", () => {
    const { provider } = makeProvider();
    expect(provider.getProviderName()).toBe("atlas-cloud");
    expect(provider.supportsSession()).toBe(true);
  });

  it("defaults to the Atlas Cloud endpoint when apiUrl is not configured", () => {
    const { provider } = makeProvider();
    expect(provider.resolveEndpoint()).toBe(ATLAS_CLOUD_API_URL);
  });

  it("strips a trailing slash from a configured apiUrl", () => {
    const { provider } = makeProvider({ apiUrl: "https://proxy.example.com/v1/" });
    expect(provider.resolveEndpoint()).toBe("https://proxy.example.com/v1");
  });

  it("defaults to deepseek-ai/deepseek-v4-pro", () => {
    const { provider } = makeProvider();
    expect(provider.resolveModel()).toBe(ATLAS_CLOUD_DEFAULT_MODEL);
  });

  it("returns a configured model unchanged", () => {
    const { provider } = makeProvider({ model: "qwen/qwen3-coder" });
    expect(provider.resolveModel()).toBe("qwen/qwen3-coder");
  });

  it("records the atlas-cloud session provider tag", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "login fail",
      }) as Response) as typeof fetch;

    const { provider, sessionManager } = makeProvider();
    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(sessionManager.lastCreateSessionArgs?.provider).toBe("atlas-cloud");
  });

  it("targets /chat/completions on Atlas Cloud and authenticates with Bearer", async () => {
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

    expect(capturedUrl).toBe(`${ATLAS_CLOUD_API_URL}/chat/completions`);
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer atlas-test-key");
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

    expect(capturedBody?.model).toBe(ATLAS_CLOUD_DEFAULT_MODEL);
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

describe("AIProviderFactory atlas-cloud wiring", () => {
  it("creates an Atlas Cloud provider and lists it as supported", () => {
    const provider = AIProviderFactory.createProvider("atlas-cloud", {
      model: "",
      apiUrl: "",
      apiKey: "atlas-test-key",
    });
    expect(provider).toBeInstanceOf(AtlasCloudProvider);
    expect(provider.getProviderName()).toBe("atlas-cloud");
    expect(AIProviderFactory.getSupportedProviders()).toContain("atlas-cloud");
  });
});
