import { afterEach, describe, expect, it } from "bun:test";
import { DeepSeekProvider } from "../src/services/ai/providers/deepseek.js";
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

  getSession(): any {
    return null;
  }

  createSession(): any {
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

function makeProvider(config: Record<string, unknown> = {}) {
  return new DeepSeekProvider(
    { model: "deepseek-chat", apiKey: "test-key", ...config },
    new FakeSessionManager() as any
  );
}

function makeFetch(response: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}) {
  const textBody =
    typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? "error");
  const jsonBody = typeof response.body === "string" ? {} : (response.body ?? {});
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return {
      ok: response.ok ?? false,
      status: response.status ?? 400,
      statusText: response.statusText ?? "Bad Request",
      text: async () => textBody,
      json: async () => jsonBody,
    } as Response;
  }) as typeof fetch;
}

describe("DeepSeekProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("getProviderName returns deepseek", () => {
    expect(makeProvider().getProviderName()).toBe("deepseek");
  });

  it("supportsSession returns true", () => {
    expect(makeProvider().supportsSession()).toBe(true);
  });

  it("uses provided apiUrl for the request", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = String(input);
      return { ok: false, status: 400, statusText: "Bad", text: async () => "err" } as Response;
    }) as typeof fetch;

    await makeProvider({ apiUrl: "https://api.deepseek.com" }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(capturedUrl).toBe("https://api.deepseek.com/chat/completions");
  });

  it("respects custom apiUrl when provided", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = String(input);
      return { ok: false, status: 400, statusText: "Bad", text: async () => "err" } as Response;
    }) as typeof fetch;

    await makeProvider({ apiUrl: "https://custom.example.com/v1" }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(capturedUrl).toBe("https://custom.example.com/v1/chat/completions");
  });

  it("sends Authorization Bearer header", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: false, status: 400, statusText: "Bad", text: async () => "err" } as Response;
    }) as typeof fetch;

    await makeProvider({ apiKey: "sk-mykey" }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(capturedHeaders?.Authorization).toBe("Bearer sk-mykey");
  });

  it("omits Authorization header when apiKey is not set", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: false, status: 400, statusText: "Bad", text: async () => "err" } as Response;
    }) as typeof fetch;

    await makeProvider({ apiKey: undefined }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(capturedHeaders?.Authorization).toBeUndefined();
  });

  it("sends model, messages, tools, tool_choice in request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return { ok: false, status: 400, statusText: "Bad", text: async () => "err" } as Response;
    }) as typeof fetch;

    await makeProvider({ model: "deepseek-reasoner" }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(capturedBody?.model).toBe("deepseek-reasoner");
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
    expect(Array.isArray(capturedBody?.tools)).toBe(true);
    expect(capturedBody?.tool_choice).toBe("auto");
  });

  it("includes temperature 0.3 by default", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return { ok: false, status: 400, statusText: "Bad", text: async () => "err" } as Response;
    }) as typeof fetch;

    await makeProvider().executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody?.temperature).toBe(0.3);
  });

  it("omits temperature when memoryTemperature is false", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return { ok: false, status: 400, statusText: "Bad", text: async () => "err" } as Response;
    }) as typeof fetch;

    await makeProvider({ memoryTemperature: false }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(capturedBody?.temperature).toBeUndefined();
  });

  it("returns success: false with error message on API error response", async () => {
    globalThis.fetch = makeFetch({ ok: false, status: 401, body: "Unauthorized" });

    const result = await makeProvider().executeToolCall("system", "user", toolSchema, "session-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("401");
  });

  it("returns friendly message on temperature unsupported error", async () => {
    globalThis.fetch = makeFetch({
      ok: false,
      status: 400,
      body: '{"error": {"type": "unsupported_value", "param": "temperature"}}',
    });

    const result = await makeProvider().executeToolCall("system", "user", toolSchema, "session-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("memoryTemperature");
  });

  it("returns success: false when response has no choices", async () => {
    globalThis.fetch = makeFetch({ ok: true, body: { choices: [] } } as any);

    const result = await makeProvider().executeToolCall("system", "user", toolSchema, "session-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid API response format");
  });

  it("returns success: false when API returns error in response body", async () => {
    globalThis.fetch = makeFetch({
      ok: true,
      body: { status: "error", msg: "quota exceeded" },
    } as any);

    const result = await makeProvider().executeToolCall("system", "user", toolSchema, "session-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("quota exceeded");
  });

  it("returns success: false after max iterations with no tool call", async () => {
    globalThis.fetch = makeFetch({
      ok: true,
      body: {
        choices: [{ message: { content: "I will not use a tool", tool_calls: undefined } }],
      },
    } as any);

    const result = await makeProvider({ maxIterations: 2 }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Max iterations");
    expect(result.iterations).toBe(2);
  });

  it("returns success: true when model calls the correct tool", async () => {
    const validArguments = JSON.stringify({
      preferences: [],
      patterns: [],
      workflows: [],
      codingStyle: {},
      domainKnowledge: [],
    });

    globalThis.fetch = makeFetch({
      ok: true,
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "save_memories", arguments: validArguments },
                },
              ],
            },
          },
        ],
      },
    } as any);

    const result = await makeProvider().executeToolCall("system", "user", toolSchema, "session-id");

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it("returns success: false when model calls wrong tool name", async () => {
    globalThis.fetch = makeFetch({
      ok: true,
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "wrong_tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
    } as any);

    const result = await makeProvider({ maxIterations: 1 }).executeToolCall(
      "system",
      "user",
      toolSchema,
      "session-id"
    );

    expect(result.success).toBe(false);
  });
});
