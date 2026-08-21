import { afterEach, describe, expect, it } from "bun:test";
import { AIProviderFactory } from "../src/services/ai/ai-provider-factory.js";
import { AtlasCloudProvider } from "../src/services/ai/providers/atlas-cloud.js";
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
  readonly session = { id: "session-1" };
  readonly messages: any[] = [];
  lastCreateSessionArgs: any;

  getSession(): null {
    return null;
  }

  createSession(args: any): { id: string } {
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

  updateSession(): void {}
}

describe("AtlasCloudProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is available from the provider factory", () => {
    const provider = AIProviderFactory.createProvider("atlas-cloud", {
      model: "deepseek-ai/deepseek-v4-pro",
      apiUrl: "https://api.atlascloud.ai/v1",
      apiKey: "atlas-test-key",
    });

    expect(provider).toBeInstanceOf(AtlasCloudProvider);
    expect(provider.getProviderName()).toBe("atlas-cloud");
    expect(AIProviderFactory.getSupportedProviders()).toContain("atlas-cloud");
  });

  it("uses Atlas Cloud Chat Completions and stores an Atlas session", async () => {
    let requestUrl = "";
    let authorization = "";
    let requestBody: Record<string, unknown> = {};

    const validArguments = JSON.stringify({
      preferences: [],
      patterns: [],
      workflows: [],
      codingStyle: {},
      domainKnowledge: [],
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "save_memories", arguments: validArguments },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const sessionManager = new FakeSessionManager();
    const provider = new AtlasCloudProvider(
      {
        model: "deepseek-ai/deepseek-v4-pro",
        apiUrl: "https://api.atlascloud.ai/v1",
        apiKey: "atlas-test-key",
      },
      sessionManager as any
    );

    const result = await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(result.success).toBe(true);
    expect(requestUrl).toBe("https://api.atlascloud.ai/v1/chat/completions");
    expect(authorization).toBe("Bearer atlas-test-key");
    expect(requestBody.model).toBe("deepseek-ai/deepseek-v4-pro");
    expect(sessionManager.lastCreateSessionArgs).toEqual({
      provider: "atlas-cloud",
      sessionId: "session-id",
    });
  });
});
