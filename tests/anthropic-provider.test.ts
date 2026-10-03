import { afterEach, describe, expect, it } from "bun:test";
import { AnthropicMessagesProvider } from "../src/ai/providers/anthropic-messages.js";
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

describe("AnthropicMessagesProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends required max_tokens in Anthropic message requests", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "bad request",
      } as Response;
    }) as typeof fetch;

    const provider = new AnthropicMessagesProvider(
      {
        model: "claude-3-5-sonnet-latest",
        apiUrl: "https://api.anthropic.com/v1",
        apiKey: "test-key",
      },
      new FakeSessionManager() as any
    );

    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.max_tokens).toBeDefined();
  });

  it("uses configured maxTokens when provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "bad request",
      } as Response;
    }) as typeof fetch;

    const provider = new AnthropicMessagesProvider(
      {
        model: "claude-3-5-sonnet-latest",
        apiUrl: "https://api.anthropic.com/v1",
        apiKey: "test-key",
        maxTokens: 2048,
      },
      new FakeSessionManager() as any
    );

    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody?.max_tokens).toBe(2048);
  });
});
