import { describe, expect, it } from "bun:test";
import {
  assertWebServerNetworkAuth,
  authorizeApiRequest,
  isLoopbackHost,
} from "../src/services/web-api-auth.js";

describe("web api auth", () => {
  it("detects loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("requires api token for non-loopback hosts", () => {
    expect(() => assertWebServerNetworkAuth("0.0.0.0")).toThrow(/webServerApiToken/);
    expect(() => assertWebServerNetworkAuth("0.0.0.0", "secret")).not.toThrow();
    expect(() => assertWebServerNetworkAuth("127.0.0.1")).not.toThrow();
  });

  it("authorizes bearer and custom header tokens", () => {
    const token = "test-token";
    expect(authorizeApiRequest(new Request("http://localhost/api/stats"), token)?.status).toBe(401);
    expect(
      authorizeApiRequest(
        new Request("http://localhost/api/stats", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        token
      )
    ).toBeNull();
    expect(
      authorizeApiRequest(
        new Request("http://localhost/api/stats", {
          headers: { "X-Opencode-Mem-Token": token },
        }),
        token
      )
    ).toBeNull();
    expect(authorizeApiRequest(new Request("http://localhost/api/stats"), undefined)).toBeNull();
  });
});
