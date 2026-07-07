import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryProviderConfig } from "../src/services/ai/provider-config.js";
import { OpenAIChatCompletionProvider } from "../src/services/ai/providers/openai-chat-completion.js";
import { OpenAIResponsesProvider } from "../src/services/ai/providers/openai-responses.js";
import type { ChatCompletionTool } from "../src/services/ai/tools/tool-schema.js";

const toolSchema: ChatCompletionTool = {
  type: "function",
  function: {
    name: "save_memory",
    description: "Save memory",
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

  getSession(): null {
    return null;
  }

  createSession(): { id: string } {
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

describe("AI provider config", () => {
  const originalFetch = globalThis.fetch;
  const originalLogFileEnv = process.env.OPENCODE_MEM_LOG_FILE;
  const logDir = mkdtempSync(join(tmpdir(), "opencode-mem-logs-"));
  const logFile = join(logDir, "opencode-mem.log");

  process.env.OPENCODE_MEM_LOG_FILE = logFile;

  beforeEach(() => {
    rmSync(logFile, { force: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    if (originalLogFileEnv === undefined) {
      delete process.env.OPENCODE_MEM_LOG_FILE;
    } else {
      process.env.OPENCODE_MEM_LOG_FILE = originalLogFileEnv;
    }
    rmSync(logDir, { recursive: true, force: true });
  });

  it("builds provider config with memoryTemperature from runtime config", () => {
    const providerConfig = buildMemoryProviderConfig({
      memoryModel: "gpt-5-nano",
      memoryApiUrl: "https://api.openai.com/v1",
      memoryApiKey: "sk-test",
      memoryTemperature: false,
      autoCaptureMaxIterations: 7,
      autoCaptureIterationTimeout: 1234,
    });

    expect(providerConfig).toEqual({
      model: "gpt-5-nano",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      memoryTemperature: false,
      maxIterations: 7,
      iterationTimeout: 1234,
    });
  });

  it("rejects placeholder API keys before a provider request is built", () => {
    expect(() =>
      buildMemoryProviderConfig({
        memoryModel: "gpt-4o-mini",
        memoryApiUrl: "https://api.openai.com/v1",
        memoryApiKey: "sk-...",
      })
    ).toThrow("replace the placeholder memoryApiKey value");
  });

  it("reports each missing manual provider field before a provider request is built", () => {
    expect(() => buildMemoryProviderConfig({})).toThrow(
      "missing memoryModel; missing memoryApiUrl; missing memoryApiKey"
    );
  });

  it("reports missing fields and placeholder API key together", () => {
    expect(() =>
      buildMemoryProviderConfig({
        memoryApiKey: "sk-...",
      })
    ).toThrow(
      "missing memoryModel; missing memoryApiUrl; replace the placeholder memoryApiKey value"
    );
  });

  it("requires an API key for manual provider endpoints", () => {
    expect(() =>
      buildMemoryProviderConfig({
        memoryModel: "gpt-4o-mini",
        memoryApiUrl: "https://api.openai.com/v1",
      })
    ).toThrow("missing memoryApiKey");
  });

  it("omits temperature for openai-chat when memoryTemperature is false", async () => {
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

    const provider = new OpenAIChatCompletionProvider(
      {
        model: "gpt-5-nano",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        memoryTemperature: false,
      },
      new FakeSessionManager() as any
    );

    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.temperature).toBeUndefined();
  });

  it("uses provided temperature for openai-chat when explicitly configured", async () => {
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

    const provider = new OpenAIChatCompletionProvider(
      {
        model: "gpt-4.1-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        memoryTemperature: 1,
      },
      new FakeSessionManager() as any
    );

    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody?.temperature).toBe(1);
  });

  it("logs provider and model context for openai-chat API errors", async () => {
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "bad request",
      } as Response;
    }) as unknown as typeof fetch;

    const beforeLog = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";

    const provider = new OpenAIChatCompletionProvider(
      {
        model: "gpt-5-nano",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        memoryTemperature: false,
      },
      new FakeSessionManager() as any
    );

    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    const afterLog = readFileSync(logFile, "utf-8");
    const appendedLog = afterLog.slice(beforeLog.length);

    expect(appendedLog).toContain('"provider":"openai-chat"');
    expect(appendedLog).toContain('"model":"gpt-5-nano"');
  });

  it("logs provider and model context for response-body API errors", async () => {
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({ status: 500, msg: "body failure" }),
      } as Response;
    }) as unknown as typeof fetch;

    const beforeLog = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";

    const provider = new OpenAIChatCompletionProvider(
      {
        model: "gpt-5-nano",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        memoryTemperature: false,
      },
      new FakeSessionManager() as any
    );

    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    const afterLog = readFileSync(logFile, "utf-8");
    const appendedLog = afterLog.slice(beforeLog.length);

    expect(appendedLog).toContain('"provider":"openai-chat"');
    expect(appendedLog).toContain('"model":"gpt-5-nano"');
  });

  it("never sends temperature for openai-responses", async () => {
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

    const provider = new OpenAIResponsesProvider(
      {
        model: "gpt-5-nano",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        memoryTemperature: false,
      },
      new FakeSessionManager() as any
    );

    await provider.executeToolCall("system", "user", toolSchema, "session-id");

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.temperature).toBeUndefined();
  });
});
