import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "opencode-mem-idle-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

const { CONFIG } = await import("../src/config.js");
const { EmbeddingService } = await import("../src/services/embedding.js");

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
});

function makeService(): { service: any; disposed: string[] } {
  const disposed: string[] = [];
  const service = new EmbeddingService();
  service.pipe = Object.assign(async () => ({ data: new Float32Array([1, 2, 3]) }), {
    dispose: async () => {
      disposed.push("dispose");
    },
  });
  service.isWarmedUp = true;
  return { service, disposed };
}

async function withIdleTimeout(ms: number, run: () => Promise<void>): Promise<void> {
  const previous = CONFIG.embeddingIdleTimeoutMs;
  CONFIG.embeddingIdleTimeoutMs = ms;
  CONFIG.embeddingApiUrl = undefined;
  CONFIG.embeddingApiKey = undefined;
  try {
    await run();
  } finally {
    CONFIG.embeddingIdleTimeoutMs = previous;
  }
}

describe("EmbeddingService idle release", () => {
  it("disposes the local pipeline after the idle timeout", async () => {
    await withIdleTimeout(20, async () => {
      const { service, disposed } = makeService();
      await service.embed("hello");
      expect(disposed).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(disposed).toEqual(["dispose"]);
      expect(service.isWarmedUp).toBe(false);
      expect(service.pipe).toBeNull();
    });
  });

  it("keeps the model loaded when the timeout is 0", async () => {
    await withIdleTimeout(0, async () => {
      const { service, disposed } = makeService();
      await service.embed("hello");

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(disposed).toEqual([]);
      expect(service.isWarmedUp).toBe(true);
    });
  });

  it("defers disposal while an embed is in flight and releases it afterwards", async () => {
    await withIdleTimeout(0, async () => {
      const { service, disposed } = makeService();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      service.pipe = Object.assign(
        async () => {
          await gate;
          return { data: new Float32Array([1]) };
        },
        { dispose: async () => disposed.push("dispose") }
      );

      const running = service.embed("in-flight");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.dispose("client-close");

      // The running embed still holds the pipeline, so nothing is released yet.
      expect(disposed).toEqual([]);

      release();
      await running;
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Release happens without a second dispose() call, even with the timer off.
      expect(disposed).toEqual(["dispose"]);
      expect(service.isWarmedUp).toBe(false);
      expect(service.pipe).toBeNull();
    });
  });
});
