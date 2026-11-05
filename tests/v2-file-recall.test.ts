import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { registerV2Adapter } from "../src/v2/adapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(workspaceID?: string) {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const tools = new Map<string, (event: any) => Promise<void>>();
  const calls: Array<{ sessionID: string; paths?: readonly string[]; promptMessageID?: string }> =
    [];
  const delivered = new Map<string, string>();
  let sequence = 0;
  const state = { enabled: true, fileEnabled: true, accept: true, always: false };
  let nextEvent = deferred<any>();
  let eventHandled = deferred<void>();
  let implementation = async (
    sessionID: string,
    paths?: readonly string[],
    _baseContext?: string
  ) =>
    paths
      ? `files:${sessionID}:${paths.map((path) => relative("/project", path).replaceAll("\\", "/")).join(",")}`
      : `ordinary:${sessionID}`;
  const ctx = {
    location: { directory: "/project", workspaceID },
    tool: {
      transform: async () => {},
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        tools.set(name, callback);
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        hooks.set(name, callback);
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        signal.addEventListener("abort", () => nextEvent.resolve(null), { once: true });
        while (!signal.aborted) {
          const event = await nextEvent.promise;
          nextEvent = deferred<any>();
          if (event) yield event;
          eventHandled.resolve();
        }
      },
    },
  } as any;
  const dispose = await registerV2Adapter(ctx, {
    tool: { memory: { description: "memory" } },
    memoryContext: {
      enabled: () => state.enabled,
      fileRecallEnabled: () => state.fileEnabled,
      refreshOnPrompt: () => state.always,
      capturePrompt: async () => state.accept,
      load: async (sessionID: string) => {
        calls.push({ sessionID });
        return implementation(sessionID);
      },
      loadFileContext: async (
        sessionID: string,
        paths: readonly string[],
        promptMessageID: string,
        baseContext: string
      ) => {
        calls.push({ sessionID, paths, promptMessageID });
        return implementation(sessionID, paths, baseContext);
      },
    },
    event: async () => {},
  });
  async function context(sessionID = "a", messageIDs = [delivered.get(sessionID)]) {
    const event = {
      sessionID,
      model: {},
      messages: messageIDs.map((id) => ({ id, role: "user" })),
      system: [] as Array<{ text: string }>,
    };
    await hooks.get("context")!(event);
    return event.system.map((part) => part.text);
  }
  async function begin(
    path = "src/example.ts",
    sessionID = "a",
    extra: Record<string, unknown> = {}
  ) {
    const event = {
      sessionID,
      messageID: `assistant-${delivered.get(sessionID)}`,
      id: `tool-call-${++sequence}`,
      tool: "read",
      status: "completed",
      input: { path },
      result: { output: { type: "text-page", content: "source" } },
      ...extra,
    };
    await tools.get("execute.before")!(event);
    return event;
  }
  return {
    calls,
    state,
    dispose,
    setLoad: (load: typeof implementation) => (implementation = load),
    prompt: async (sessionID = "a", deliver = true) => {
      const messageID = `prompt-${++sequence}`;
      await hooks.get("prompt")!({ sessionID, messageID, prompt: { text: "fix this" } });
      if (deliver) {
        delivered.set(sessionID, messageID);
        await context(sessionID);
      }
      return messageID;
    },
    deliver: (messageID: string, sessionID = "a") => delivered.set(sessionID, messageID),
    begin,
    finish: (event: any) => tools.get("execute.after")!(event),
    observe: async (
      path = "src/example.ts",
      sessionID = "a",
      extra: Record<string, unknown> = {}
    ) => tools.get("execute.after")!(await begin(path, sessionID, extra)),
    context,
    compact: (sessionID = "a") => hooks.get("compaction")!({ sessionID }),
    event: async (type: string, sessionID = "a", directory = "/project") => {
      eventHandled = deferred<void>();
      nextEvent.resolve({ type, data: { sessionID }, location: { directory } });
      await eventHandled.promise;
    },
  };
}

describe("V2 observed-file recall boundaries", () => {
  let directory: string;
  let previousLogFile: string | undefined;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "opencode-mem-file-recall-"));
    previousLogFile = process.env.OPENCODE_MEM_LOG_FILE;
    process.env.OPENCODE_MEM_LOG_FILE = join(directory, "plugin.log");
  });
  afterEach(() => {
    if (previousLogFile === undefined) delete process.env.OPENCODE_MEM_LOG_FILE;
    else process.env.OPENCODE_MEM_LOG_FILE = previousLogFile;
    rmSync(directory, { recursive: true, force: true });
  });

  it("waits for the next context boundary, replaces one block and deduplicates repeated reads", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      expect(await f.context()).toEqual(["ordinary:a"]);
      await f.observe();
      await f.observe();
      expect(f.calls).toHaveLength(1);
      expect(await f.context()).toEqual(["files:a:src/example.ts"]);
      expect(await f.context()).toEqual(["files:a:src/example.ts"]);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1]?.paths).toEqual([resolve("/project", "src/example.ts")]);
      for (const alias of ["./src/example.ts", "/project/src/example.ts", "src//example.ts"]) {
        await f.observe(alias);
        expect(await f.context()).toEqual(["files:a:src/example.ts"]);
      }
      expect(f.calls).toHaveLength(2);
      await f.observe("src/new.ts");
      expect(await f.context()).toEqual(["files:a:src/example.ts,src/new.ts"]);
    } finally {
      await f.dispose();
    }
  });

  it("requires an accepted prompt and isolates sessions", async () => {
    const f = await fixture();
    try {
      await f.observe();
      expect(await f.context()).toEqual(["ordinary:a"]);
      await f.prompt();
      await f.prompt("b");
      await f.observe("src/a.ts");
      await f.observe("src/b.ts", "b");
      expect(await f.context()).toEqual(["files:a:src/a.ts"]);
      expect(await f.context("b")).toEqual(["files:b:src/b.ts"]);
      f.state.accept = false;
      await f.prompt();
      await f.observe("src/suppressed.ts");
      expect(await f.context()).toEqual([]);
      expect(await f.context("b")).toEqual(["files:b:src/b.ts"]);
    } finally {
      await f.dispose();
    }
  });

  it("ignores failed, unknown, malformed and directory tools", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      await f.observe("src/failed.ts", "a", { status: "error" });
      await f.observe("src/bash.ts", "a", { tool: "bash" });
      await f.observe("src/malformed.ts", "a", { input: { path: ["src/malformed.ts"] } });
      await f.observe("src", "a", { result: { output: { type: "list-page" } } });
      await f.observe("src/invalid-id.ts", "a", { id: "x".repeat(513) });
      expect(await f.context()).toEqual(["ordinary:a"]);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it("caps bulk observations and refreshes per turn, then restores ordinary first-mode context", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      for (let i = 0; i < 40; i++) await f.observe(`src/${i}.ts`);
      await f.context();
      expect(f.calls.at(-1)?.paths).toHaveLength(16);
      await f.prompt();
      expect(await f.context()).toEqual(["ordinary:a"]);
      for (let i = 0; i < 10; i++) {
        await f.observe(`src/next-${i}.ts`);
        await f.context();
      }
      expect(f.calls.filter((call) => call.paths)).toHaveLength(5);
      await f.prompt();
      await f.observe("src/new-turn.ts");
      expect(await f.context()).toEqual(["files:a:src/new-turn.ts"]);
    } finally {
      await f.dispose();
    }
  });

  it("falls back to ordinary context after errors without retrying the same candidates", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      await f.observe();
      await f.context();
      f.setLoad(async () => {
        throw new Error("unavailable");
      });
      await f.observe("src/second.ts");
      expect(await f.context()).toEqual(["ordinary:a"]);
      const attempts = f.calls.length;
      expect(await f.context()).toEqual(["ordinary:a"]);
      await f.observe();
      await f.context();
      expect(f.calls).toHaveLength(attempts);
      f.setLoad(async () => "recovered");
      await f.observe("src/third.ts");
      expect(await f.context()).toEqual(["recovered"]);
    } finally {
      await f.dispose();
    }
  });

  it("passes the original cached base to no-match refreshes, including after a positive match", async () => {
    const f = await fixture();
    try {
      const original = "cached ordinary context\r\n<user_profile>unchanged</user_profile>\n";
      f.setLoad(async () => original);
      await f.prompt();
      f.setLoad(async (_sessionID, paths, baseContext) => {
        if (!paths) throw new Error("Ordinary recall must not run for an observation");
        expect(baseContext).toBe(original);
        return paths.length === 2 ? "positive file match" : baseContext!;
      });
      await f.observe("src/no-match.ts");
      expect(await f.context()).toEqual([original]);
      await f.observe("src/has-match.ts");
      expect(await f.context()).toEqual(["positive file match"]);
      await f.observe("src/match-removed.ts");
      expect(await f.context()).toEqual([original]);
      expect(f.calls.filter((call) => !call.paths)).toHaveLength(1);
      expect(f.calls.filter((call) => call.paths)).toHaveLength(3);
    } finally {
      await f.dispose();
    }
  });

  it("opts out safely and retains existing always-mode refresh behavior", async () => {
    const f = await fixture();
    try {
      f.state.fileEnabled = false;
      f.state.always = true;
      await f.prompt();
      await f.observe();
      expect(await f.context()).toEqual(["ordinary:a"]);
      await f.prompt();
      expect(f.calls).toHaveLength(2);
      f.state.fileEnabled = true;
      await f.prompt();
      await f.observe();
      expect(await f.context()).toEqual(["files:a:src/example.ts"]);
      f.state.fileEnabled = false;
      expect(await f.context()).toEqual(["ordinary:a"]);
      f.state.enabled = false;
      expect(await f.context()).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("invalidates file observations on local compaction and deletion only", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      await f.observe();
      await f.context();
      await f.event("session.compaction.ended", "a", "/elsewhere");
      expect(await f.context()).toEqual(["files:a:src/example.ts"]);
      await f.event("session.compaction.ended");
      await f.observe("src/after-compaction.ts");
      expect(await f.context()).toEqual(["ordinary:a"]);
      await f.prompt();
      await f.observe();
      await f.context();
      await f.event("session.deleted");
      await f.observe("src/after-deletion.ts");
      expect(await f.context()).toEqual(["ordinary:a"]);
      expect(f.calls.filter((call) => call.paths)).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  });

  it("clears file context synchronously before compaction even when the prompt remains in history", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      await f.prompt("b");
      await f.observe();
      await f.observe("src/other.ts", "b");
      expect(await f.context()).toEqual(["files:a:src/example.ts"]);
      expect(await f.context("b")).toEqual(["files:b:src/other.ts"]);
      await f.compact();
      await f.observe("src/after-compaction.ts");
      expect(await f.context()).toEqual(["ordinary:a"]);
      expect(await f.context("b")).toEqual(["files:b:src/other.ts"]);
      expect(f.calls.filter((call) => call.paths)).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  });

  it("keeps managed workspace files out of local filesystem recall", async () => {
    const f = await fixture("workspace-remote");
    try {
      await f.prompt();
      await f.observe();
      expect(await f.context()).toEqual(["ordinary:a"]);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it("preserves ordinary first-mode caching during speculative compaction when file recall is disabled", async () => {
    const f = await fixture();
    try {
      f.state.fileEnabled = false;
      await f.prompt();
      f.setLoad(async () => "changed store");
      await f.compact();
      expect(await f.context()).toEqual(["ordinary:a"]);
      expect(f.calls).toHaveLength(1);
      await f.event("session.compaction.ended");
      expect(await f.context()).toEqual(["changed store"]);
    } finally {
      await f.dispose();
    }
  });

  it("rejects an in-flight file lookup from a previous turn", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      const pending = deferred<string>();
      f.setLoad(async (_sessionID, paths) => (paths ? pending.promise : "ordinary:a"));
      await f.observe();
      const oldContext = f.context();
      await f.prompt();
      pending.resolve("stale file match");
      expect(await oldContext).toEqual(["ordinary:a"]);
      expect(await f.context()).toEqual(["ordinary:a"]);
    } finally {
      await f.dispose();
    }
  });

  it("does not let an older prompt lookup replace the newer turn's ordinary context", async () => {
    const f = await fixture();
    try {
      f.state.always = true;
      const pending = deferred<string>();
      let calls = 0;
      f.setLoad(async () => (++calls === 1 ? pending.promise : "new prompt context"));
      const firstPrompt = f.prompt("a", false);
      // Allow the first prompt capture to reach its deferred context lookup.
      await Promise.resolve();
      const latest = await f.prompt("a", false);
      pending.resolve("old prompt context");
      await firstPrompt;
      f.deliver(latest);
      expect(await f.context()).toEqual(["new prompt context"]);
    } finally {
      await f.dispose();
    }
  });

  it("activates queued prompts only after delivery and rejects tools belonging to the older turn", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      const oldTool = await f.begin("src/old-running.ts");
      const queued = await f.prompt("a", false);
      await f.finish(oldTool);
      await f.observe("src/old-streaming.ts");
      expect(await f.context()).toEqual(["ordinary:a"]);
      expect(f.calls.filter((call) => call.paths)).toHaveLength(0);
      f.deliver(queued);
      await f.context();
      await f.finish(oldTool);
      await f.observe("src/delivered.ts");
      expect(await f.context()).toEqual(["files:a:src/delivered.ts"]);
      expect(f.calls.at(-1)?.promptMessageID).toBe(queued);
    } finally {
      await f.dispose();
    }
  });

  it("fails closed when prompt identity is missing or only an intermediate queued prompt was delivered", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      await f.observe();
      await f.context();
      expect(await f.context("a", [])).toEqual(["ordinary:a"]);
      await f.observe("src/no-identity.ts");
      expect(await f.context("a", [])).toEqual(["ordinary:a"]);
      const intermediate = await f.prompt("a", false);
      const latest = await f.prompt("a", false);
      f.deliver(intermediate);
      await f.context();
      await f.observe("src/intermediate.ts");
      expect(await f.context()).toEqual(["ordinary:a"]);
      f.deliver(latest);
      await f.context();
      await f.observe("src/latest.ts");
      expect(await f.context()).toEqual(["files:a:src/latest.ts"]);
      expect(f.calls.filter((call) => call.paths)).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  });

  it("does not overwrite a newer concurrent file revision", async () => {
    const f = await fixture();
    try {
      await f.prompt();
      const pending = deferred<string>();
      f.setLoad(async (_sessionID, paths) => (paths?.length === 1 ? pending.promise : "newer"));
      await f.observe("src/one.ts");
      const older = f.context();
      await f.observe("src/two.ts");
      expect(await f.context()).toEqual(["newer"]);
      pending.resolve("older");
      expect(await older).toEqual(["newer"]);
      expect(await f.context()).toEqual(["newer"]);
    } finally {
      await f.dispose();
    }
  });

  it("rejects a lookup completing after disposal", async () => {
    const f = await fixture();
    await f.prompt();
    const pending = deferred<string>();
    f.setLoad(async () => pending.promise);
    await f.observe();
    const context = f.context();
    await f.dispose();
    pending.resolve("late match");
    expect(await context).toEqual([]);
  });
});
