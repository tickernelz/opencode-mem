import { describe, expect, it } from "bun:test";
import { findHealthyRuntimeBaseUrl } from "../src/runtime/client.js";
import { WebServer } from "../src/runtime/http/web-server.js";
import { clearRuntimeInfo, writeRuntimeInfo } from "../src/runtime/http/runtime-info.js";

describe("findHealthyRuntimeBaseUrl", () => {
  it("discovers a healthy runtime via runtime.json and port scan", async () => {
    const port = 48743;
    const server = new WebServer({ enabled: true, host: "127.0.0.1", port });
    await server.start();
    writeRuntimeInfo({
      host: "127.0.0.1",
      port,
      pid: process.pid,
      url: `http://127.0.0.1:${port}`,
      startedAt: Date.now(),
    });

    try {
      const found = await findHealthyRuntimeBaseUrl("127.0.0.1", port);
      expect(found).toBe(`http://127.0.0.1:${port}`);
    } finally {
      clearRuntimeInfo(process.pid);
      await server.stop();
    }
  });
});
