import { describe, expect, it } from "bun:test";
import {
  corsPreflightResponse,
  disallowedCorsResponse,
  isAllowedBrowserOrigin,
} from "../src/services/cors.js";

describe("web server CORS policy", () => {
  it("allows non-browser requests without an Origin header", () => {
    expect(isAllowedBrowserOrigin(null)).toBe(true);
  });

  it("allows loopback browser origins", () => {
    expect(isAllowedBrowserOrigin("http://127.0.0.1:4747")).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:4747")).toBe(true);
    expect(isAllowedBrowserOrigin("http://[::1]:4747")).toBe(true);
  });

  it("rejects non-loopback browser origins", () => {
    expect(isAllowedBrowserOrigin("https://example.com")).toBe(false);
    expect(isAllowedBrowserOrigin("null")).toBe(false);
  });

  it("returns a loopback-bound preflight response", () => {
    const response = corsPreflightResponse(
      new Request("http://127.0.0.1:4747/api/memories", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:4747",
          "Access-Control-Request-Method": "POST",
        },
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4747");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("does not expose CORS headers on rejected origins", () => {
    const response = disallowedCorsResponse();

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
