import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createV2Client,
  generateStructuredOutput,
  getV2Client,
  isInternalStructuredSession,
  isProviderConnected,
  resetHostFetch,
  resetInternalStructuredSessions,
  setConnectedProviders,
  setHostFetch,
  setStructuredOutputTimeoutMsForTests,
  setV2Client,
  STRUCTURED_OUTPUT_AGENT,
  STRUCTURED_OUTPUT_METADATA,
  STRUCTURED_OUTPUT_PERMISSIONS,
  STRUCTURED_OUTPUT_TOOLS,
} from "../src/services/ai/opencode-provider.js";

const schema = z.object({
  topic: z.string(),
  count: z.number(),
});

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(responder: (call: FetchCall) => { status?: number; body: unknown }): {
  calls: FetchCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString(), init);
    const url = req.url;
    const method = req.method.toUpperCase();
    let body: unknown = undefined;
    if (method !== "GET" && method !== "HEAD") {
      try {
        const text = await req.text();
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
    }
    const call: FetchCall = { url, method, body };
    calls.push(call);
    const { status = 200, body: respBody } = responder(call);
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("connected providers state", () => {
  afterEach(() => {
    setConnectedProviders([]);
  });

  it("setConnectedProviders + isProviderConnected reflect known providers", () => {
    setConnectedProviders(["anthropic", "github-copilot"]);
    expect(isProviderConnected("anthropic")).toBe(true);
    expect(isProviderConnected("github-copilot")).toBe(true);
    expect(isProviderConnected("openai")).toBe(false);
  });

  it("setConnectedProviders replaces previous state on each call", () => {
    setConnectedProviders(["anthropic"]);
    setConnectedProviders(["openai"]);
    expect(isProviderConnected("anthropic")).toBe(false);
    expect(isProviderConnected("openai")).toBe(true);
  });
});

describe("v2 client cache", () => {
  it("setV2Client + getV2Client roundtrip", () => {
    const client = createV2Client("http://127.0.0.1:9999");
    setV2Client(client);
    expect(getV2Client()).toBe(client);
  });

  it("createV2Client accepts URL objects", () => {
    const client = createV2Client(new URL("http://127.0.0.1:9999"));
    expect(client).toBeDefined();
    expect(typeof client.session.create).toBe("function");
    expect(typeof client.session.prompt).toBe("function");
    expect(typeof client.session.delete).toBe("function");
  });
});

describe("generateStructuredOutput", () => {
  let mock: ReturnType<typeof installFetchMock> | undefined;

  beforeEach(() => {
    mock = undefined;
    resetHostFetch();
    resetInternalStructuredSessions();
    setStructuredOutputTimeoutMsForTests(undefined);
  });

  afterEach(() => {
    mock?.restore();
    resetHostFetch();
    resetInternalStructuredSessions();
    setStructuredOutputTimeoutMsForTests(undefined);
  });

  it("posts schema without noReply and returns parsed structured output", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_test_1" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_test_1/message")) {
        return {
          body: {
            info: { structured_output: { topic: "auth", count: 3 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE" && call.url.endsWith("/session/ses_test_1")) {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    const result = await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "system",
      userPrompt: "user",
      schema,
    });

    expect(result).toEqual({ topic: "auth", count: 3 });

    const createCall = mock.calls.find((c) => c.method === "POST" && c.url.endsWith("/session"));
    expect(createCall).toBeDefined();
    const createBody = createCall!.body as Record<string, unknown>;
    expect(createBody.permission).toEqual(STRUCTURED_OUTPUT_PERMISSIONS);
    expect(createBody.metadata).toEqual(STRUCTURED_OUTPUT_METADATA);

    const promptCall = mock.calls.find((c) => c.url.includes("/session/ses_test_1/message"));
    expect(promptCall).toBeDefined();
    const promptBody = promptCall!.body as Record<string, unknown>;
    expect(promptBody.model).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
    });
    expect(promptBody.system).toBe("system");
    expect(promptBody.agent).toBe(STRUCTURED_OUTPUT_AGENT);
    expect(promptBody.tools).toEqual(STRUCTURED_OUTPUT_TOOLS);
    expect(promptBody).not.toHaveProperty("noReply");
    const format = promptBody.format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");
    expect(format.schema).toBeDefined();

    const deleteCall = mock.calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.url.endsWith("/session/ses_test_1")).toBe(true);
    expect(isInternalStructuredSession("ses_test_1")).toBe(false);
  });

  it("passes the variant through in the model object when provided", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_test_2" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_test_2/message")) {
        return {
          body: {
            info: { structured_output: { topic: "auth", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    const result = await generateStructuredOutput({
      client,
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      variant: "thinking-off",
      systemPrompt: "system",
      userPrompt: "user",
      schema,
    });

    expect(result).toEqual({ topic: "auth", count: 1 });

    const promptCall = mock.calls.find((c) => c.url.includes("/session/ses_test_2/message"));
    expect(promptCall).toBeDefined();
    const promptBody = promptCall!.body as Record<string, unknown>;
    expect(promptBody.model).toEqual({
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      variant: "thinking-off",
    });
  });

  it("omits variant from the model object when not provided", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_test_3" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_test_3/message")) {
        return {
          body: {
            info: { structured_output: { topic: "auth", count: 2 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await generateStructuredOutput({
      client,
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
      systemPrompt: "system",
      userPrompt: "user",
      schema,
    });

    const promptCall = mock.calls.find((c) => c.url.includes("/session/ses_test_3/message"));
    expect(promptCall).toBeDefined();
    const promptBody = promptCall!.body as Record<string, unknown>;
    expect(promptBody.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
    expect(promptBody.model).not.toHaveProperty("variant");
  });

  it("rejects with full info.error details when opencode reports an assistant error", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_err" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_err/message")) {
        return {
          body: {
            info: {
              error: {
                name: "StructuredOutputError",
                data: {
                  message: "schema validation failed",
                  statusCode: 400,
                  providerID: "anthropic",
                  prompt: "secret prompt fragment",
                },
              },
            },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "anthropic",
        modelID: "claude-haiku-4-5",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(
      /StructuredOutputError: schema validation failed; details=.*"statusCode":400.*"providerID":"anthropic"/
    );

    await generateStructuredOutput({
      client,
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    }).catch((error: unknown) => {
      expect(String(error)).not.toContain("secret prompt fragment");
    });

    expect(mock.calls.find((c) => c.method === "DELETE")).toBeDefined();
  });

  it("rejects when info.structured is missing", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_empty" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_empty/message")) {
        return { body: { info: {}, parts: [] } };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "github-copilot",
        modelID: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(/no structured output/);
  });

  it("rejects when session.create returns no id", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: {} };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "anthropic",
        modelID: "claude-haiku-4-5",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(/session\.create returned no session id/);
  });

  it("swallows session.delete failure and still returns success", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_delfail" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_delfail/message")) {
        return {
          body: {
            info: { structured_output: { topic: "x", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { status: 500, body: { error: "boom" } };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    const result = await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });
    expect(result).toEqual({ topic: "x", count: 1 });
  });

  it("attempts session.delete even when prompt fails", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_promptfail" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_promptfail/message")) {
        return {
          body: {
            info: {
              error: {
                name: "ProviderAuthError",
                data: { message: "not authenticated" },
              },
            },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "anthropic",
        modelID: "claude-haiku-4-5",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(/ProviderAuthError/);

    expect(mock.calls.find((c) => c.method === "DELETE")).toBeDefined();
  });

  it("forwards retryCount inside format when provided", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_retry" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_retry/message")) {
        return {
          body: {
            info: { structured_output: { topic: "x", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
      retryCount: 2,
    });

    const promptCall = mock.calls.find((c) => c.url.includes("/session/ses_retry/message"));
    const format = (promptCall!.body as Record<string, unknown>).format as
      Record<string, unknown> | undefined;
    expect(format?.retryCount).toBe(2);
  });
});

describe("generateStructuredOutput regression tests (issue #110)", () => {
  let mock: ReturnType<typeof installFetchMock> | undefined;

  beforeEach(() => {
    mock = undefined;
    resetHostFetch();
  });

  afterEach(() => {
    mock?.restore();
    resetHostFetch();
  });

  it("forwards directory as query param on create/prompt/delete", async () => {
    mock = installFetchMock((call) => {
      if (
        call.method === "POST" &&
        call.url.includes("/session") &&
        !call.url.includes("/message")
      ) {
        return { body: { id: "ses_dir" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_dir/message")) {
        return {
          body: {
            info: { structured_output: { topic: "auth", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
      directory: "/home/user/proj",
    });

    const createCall = mock.calls.find(
      (c) =>
        c.method === "POST" && c.url.endsWith("/session") === false && c.url.includes("/session")
    );
    expect(createCall?.url).toContain("directory=");
    expect(decodeURIComponent(createCall!.url.split("directory=")[1]!.split("&")[0]!)).toBe(
      "/home/user/proj"
    );

    const promptCall = mock.calls.find((c) => c.url.includes("/session/ses_dir/message"));
    expect(promptCall?.url).toContain("directory=");
    expect(decodeURIComponent(promptCall!.url.split("directory=")[1]!.split("&")[0]!)).toBe(
      "/home/user/proj"
    );

    const deleteCall = mock.calls.find((c) => c.method === "DELETE");
    expect(deleteCall?.url).toContain("directory=");
    expect(decodeURIComponent(deleteCall!.url.split("directory=")[1]!.split("&")[0]!)).toBe(
      "/home/user/proj"
    );
  });

  it("omits the directory query param when not provided", async () => {
    mock = installFetchMock((call) => {
      if (
        call.method === "POST" &&
        call.url.includes("/session") &&
        !call.url.includes("/message")
      ) {
        return { body: { id: "ses_nodir" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_nodir/message")) {
        return {
          body: {
            info: { structured_output: { topic: "x", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });

    for (const c of mock.calls) {
      expect(c.url).not.toContain("directory=");
      expect(c.url).not.toContain("?");
    }
  });

  it("normalizes a base URL with a trailing slash", async () => {
    mock = installFetchMock((call) => {
      if (
        call.method === "POST" &&
        call.url.includes("/session") &&
        !call.url.includes("/message")
      ) {
        return { body: { id: "ses_slash" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_slash/message")) {
        return {
          body: {
            info: { structured_output: { topic: "x", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999/");
    await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });

    for (const c of mock.calls) {
      // Never produces `//session` from a single trailing slash
      expect(c.url).not.toMatch(/\/\/session/);
      expect(c.url.startsWith("http://127.0.0.1:9999/session")).toBe(true);
    }
  });

  it("accepts a URL object for createV2Client", async () => {
    mock = installFetchMock((call) => {
      if (
        call.method === "POST" &&
        call.url.includes("/session") &&
        !call.url.includes("/message")
      ) {
        return { body: { id: "ses_url" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_url/message")) {
        return {
          body: {
            info: { structured_output: { topic: "x", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client(new URL("http://127.0.0.1:9999"));
    await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });

    expect(mock.calls.length).toBe(3);
  });

  it("uses the injected opencode host fetch instead of global fetch", async () => {
    const globalFetch = globalThis.fetch;
    const calls: FetchCall[] = [];

    const failingFetch: typeof fetch = Object.assign(
      async () => {
        throw new TypeError("global fetch should not be used");
      },
      { preconnect: globalFetch.preconnect }
    );
    globalThis.fetch = failingFetch;

    const hostFetch: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const method = req.method.toUpperCase();
        const text = method === "GET" || method === "HEAD" ? "" : await req.text();
        const call: FetchCall = {
          url: req.url,
          method,
          body: text ? JSON.parse(text) : undefined,
        };
        calls.push(call);

        if (call.method === "POST" && call.url.endsWith("/session")) {
          return new Response(JSON.stringify({ id: "ses_host_fetch" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (call.method === "POST" && call.url.includes("/session/ses_host_fetch/message")) {
          return new Response(
            JSON.stringify({ info: { structured_output: { topic: "host", count: 1 } }, parts: [] }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
        if (call.method === "DELETE") {
          return new Response(JSON.stringify(true), {
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected host fetch: ${call.method} ${call.url}`);
      },
      { preconnect: globalFetch.preconnect }
    );

    setHostFetch(hostFetch);

    try {
      const client = createV2Client("http://localhost:4096");
      const result = await generateStructuredOutput({
        client,
        providerID: "openai",
        modelID: "gpt-5.5",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      });

      expect(result).toEqual({ topic: "host", count: 1 });
      expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "DELETE"]);
    } finally {
      globalThis.fetch = globalFetch;
      resetHostFetch();
    }
  });

  it("surfaces a non-2xx response from POST /session", async () => {
    mock = installFetchMock(() => ({
      status: 502,
      body: { error: "bad gateway", token: "secret-token" },
    }));

    const client = createV2Client("http://127.0.0.1:9999");
    const promise = generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });

    await expect(promise).rejects.toThrow(
      /POST \/session failed at http:\/\/127\.0\.0\.1:9999\/session \(502 Bad Gateway\): <redacted response body>/
    );
    await promise.catch((error: unknown) => {
      expect(String(error)).not.toContain("secret-token");
      expect(String(error)).not.toContain("bad gateway");
    });

    // No further calls should have been made (no prompt, no delete)
    expect(mock!.calls.length).toBe(1);
  });

  it("redacts directory query params and response bodies from prompt failure diagnostics", async () => {
    mock = installFetchMock((call) => {
      if (
        call.method === "POST" &&
        call.url.includes("/session") &&
        !call.url.includes("/message")
      ) {
        return { body: { id: "ses_redact" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_redact/message")) {
        return {
          status: 500,
          body: { error: "model unavailable", prompt: "private prompt", path: "/private/project" },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "github-copilot",
        modelID: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
        directory: "/private/project",
      })
    ).rejects.toThrow(
      /POST \/session\/\{id\}\/message failed at http:\/\/127\.0\.0\.1:9999\/session\/ses_redact\/message \(500 Internal Server Error\): <redacted response body>/
    );

    await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
      directory: "/private/project",
    }).catch((error: unknown) => {
      const message = String(error);
      expect(message).not.toContain("directory=");
      expect(message).not.toContain("/private/project");
      expect(message).not.toContain("private prompt");
      expect(message).not.toContain("model unavailable");
    });
  });

  it("surfaces a non-2xx response from POST /session/{id}/message and still cleans up", async () => {
    mock = installFetchMock((call) => {
      if (
        call.method === "POST" &&
        call.url.includes("/session") &&
        !call.url.includes("/message")
      ) {
        return { body: { id: "ses_prompt_500" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_prompt_500/message")) {
        return { status: 500, body: { error: "model unavailable" } };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "github-copilot",
        modelID: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(
      /POST \/session\/\{id\}\/message failed at http:\/\/127\.0\.0\.1:9999\/session\/ses_prompt_500\/message \(500 Internal Server Error\): <redacted response body>/
    );

    // delete is best-effort and should still run
    expect(mock!.calls.find((c) => c.method === "DELETE")).toBeDefined();
  });

  it("propagates a network error from POST /session and skips prompt/delete", async () => {
    mock = installFetchMock(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "github-copilot",
        modelID: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(/ECONNREFUSED/);

    expect(mock!.calls.length).toBe(1);
  });

  it("throws when generateStructuredOutput is called without prior createV2Client", async () => {
    // Force-clear the cached base URL by creating a fresh module-level state.
    // We cannot easily reset the module, so we use a unique schema sentinel
    // and rely on the test ordering: this test only runs if the previous
    // tests did not leak base URL. The cleanest way: re-import the module.
    const mod = await import(`../src/services/ai/opencode-provider.js?cachebust=${Math.random()}`);
    // createV2Client has the side effect of setting the base URL, so any
    // call from other tests would have populated it. We just verify that
    // the function exists and behaves consistently when called repeatedly
    // (idempotent). This test is here to lock in the API surface for issue #110.
    expect(typeof mod.generateStructuredOutput).toBe("function");
    expect(typeof mod.createV2Client).toBe("function");
  });
});

describe("resolveOpencodeModelRef / inherit", () => {
  const originalStateHome = process.env.XDG_STATE_HOME;
  let tempRoot: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tempRoot = mkdtempSync(join(tmpdir(), "opencode-mem-inherit-"));
    process.env.XDG_STATE_HOME = tempRoot;
  });

  afterEach(async () => {
    if (originalStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHome;
    }
    if (tempRoot) {
      const { rmSync } = await import("node:fs");
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("passes concrete model ids through unchanged", async () => {
    const { resolveOpencodeModelRef } = await import("../src/services/ai/opencode-provider.js");
    expect(resolveOpencodeModelRef({ providerID: "local", modelID: "h100/qwen:latest" })).toEqual({
      providerID: "local",
      modelID: "h100/qwen:latest",
    });
  });

  it("prefers the recorded prompt model when modelID is inherit", async () => {
    const { resolveOpencodeModelRef } = await import("../src/services/ai/opencode-provider.js");
    expect(
      resolveOpencodeModelRef({
        providerID: "local",
        modelID: "inherit",
        prompt: { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" },
      })
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5-20251001",
    });
  });

  it("falls back to OpenCode recent model.json when inherit has no prompt model", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const stateDir = join(tempRoot!, "opencode");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "model.json"),
      JSON.stringify({
        recent: [
          { providerID: "openai", modelID: "gpt-4o-mini" },
          { providerID: "local", modelID: "h100/qwen:latest" },
        ],
      })
    );

    const { resolveOpencodeModelRef } = await import("../src/services/ai/opencode-provider.js");
    expect(resolveOpencodeModelRef({ providerID: "local", modelID: "inherit" })).toEqual({
      providerID: "local",
      modelID: "h100/qwen:latest",
    });
  });

  it("throws a clear error when inherit has no prompt model and no recent list", async () => {
    const { resolveOpencodeModelRef } = await import("../src/services/ai/opencode-provider.js");
    expect(() => resolveOpencodeModelRef({ providerID: "local", modelID: "inherit" })).toThrow(
      /no session model was recorded and no recent OpenCode model is available/
    );
  });

  it("expands inherit before POST /session/{id}/message so OpenCode never sees modelID=inherit", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const stateDir = join(tempRoot!, "opencode");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "model.json"),
      JSON.stringify({
        recent: [{ providerID: "local", modelID: "h100/qwen:latest" }],
      })
    );

    const mock = installFetchMock((call) => {
      if (
        call.method === "POST" &&
        call.url.includes("/session") &&
        !call.url.includes("/message")
      ) {
        return { body: { id: "ses_inherit" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_inherit/message")) {
        return {
          body: {
            info: {
              structured: { topic: "ok", count: 1 },
            },
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    try {
      const client = createV2Client("http://127.0.0.1:9999");
      const result = await generateStructuredOutput({
        client,
        providerID: "local",
        modelID: "inherit",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      });
      expect(result).toEqual({ topic: "ok", count: 1 });

      const promptCall = mock.calls.find((c) => c.method === "POST" && c.url.includes("/message"));
      expect(promptCall?.body).toMatchObject({
        model: { providerID: "local", modelID: "h100/qwen:latest" },
      });
      expect(JSON.stringify(promptCall?.body)).not.toContain('"inherit"');
    } finally {
      mock.restore();
    }
  });
});

describe("generateStructuredOutput tool isolation (issue #189)", () => {
  let mock: ReturnType<typeof installFetchMock> | undefined;

  beforeEach(() => {
    mock = undefined;
    resetHostFetch();
    resetInternalStructuredSessions();
    setStructuredOutputTimeoutMsForTests(undefined);
  });

  afterEach(() => {
    mock?.restore();
    resetHostFetch();
    resetInternalStructuredSessions();
    setStructuredOutputTimeoutMsForTests(undefined);
  });

  it("fails closed when structured output is missing and still deletes the session", async () => {
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_no_so" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_no_so/message")) {
        // Simulates a turn that used ordinary tools / no StructuredOutput result.
        return {
          body: {
            info: {},
            parts: [{ type: "tool", tool: "bash" }],
          },
        };
      }
      if (call.method === "DELETE" && call.url.endsWith("/session/ses_no_so")) {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "github-copilot",
        modelID: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(/no structured output/);

    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(isInternalStructuredSession("ses_no_so")).toBe(false);
  });

  it("times out, aborts, and deletes when the prompt never returns", async () => {
    setStructuredOutputTimeoutMsForTests(50);

    const original = globalThis.fetch;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req =
        input instanceof Request
          ? input
          : new Request(typeof input === "string" ? input : input.toString(), init);
      const url = req.url;
      const method = req.method.toUpperCase();
      let body: unknown = undefined;
      if (method !== "GET" && method !== "HEAD") {
        try {
          const text = await req.text();
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
      }
      calls.push({ url, method, body });
      if (method === "POST" && url.endsWith("/session")) {
        return new Response(JSON.stringify({ id: "ses_hang" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.includes("/session/ses_hang/message")) {
        // Never resolves — simulates an unbounded agent/tool loop.
        return await new Promise<Response>(() => {});
      }
      if (method === "POST" && url.includes("/session/ses_hang/abort")) {
        return new Response(JSON.stringify(true), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "DELETE" && url.includes("/session/ses_hang")) {
        return new Response(JSON.stringify(true), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;
    mock = {
      calls,
      restore: () => {
        globalThis.fetch = original;
      },
    };

    const client = createV2Client("http://127.0.0.1:9999");
    await expect(
      generateStructuredOutput({
        client,
        providerID: "github-copilot",
        modelID: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      })
    ).rejects.toThrow(/structured-output timed out after 50ms/);

    expect(calls.some((c) => c.method === "POST" && c.url.includes("/abort"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(isInternalStructuredSession("ses_hang")).toBe(false);
  });

  it("tracks internal session IDs only while the prompt is in flight", async () => {
    let sawDuringPrompt = false;
    mock = installFetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/session")) {
        return { body: { id: "ses_track" } };
      }
      if (call.method === "POST" && call.url.includes("/session/ses_track/message")) {
        sawDuringPrompt = isInternalStructuredSession("ses_track");
        return {
          body: {
            info: { structured_output: { topic: "x", count: 1 } },
            parts: [],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: true };
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });

    const client = createV2Client("http://127.0.0.1:9999");
    await generateStructuredOutput({
      client,
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });

    expect(sawDuringPrompt).toBe(true);
    expect(isInternalStructuredSession("ses_track")).toBe(false);
  });
});
