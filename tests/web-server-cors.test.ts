import { describe, expect, it } from "bun:test";
import {
  corsPreflightResponse,
  disallowedCorsResponse,
  isAllowedBrowserOrigin,
} from "../src/services/cors.js";

describe("web server CORS policy", () => {
  describe("isAllowedBrowserOrigin", () => {
    it("allows non-browser requests without an Origin header", () => {
      expect(isAllowedBrowserOrigin(null)).toBe(true);
    });

    it("allows loopback browser origins", () => {
      expect(isAllowedBrowserOrigin("http://127.0.0.1:4747")).toBe(true);
      expect(isAllowedBrowserOrigin("http://localhost:4747")).toBe(true);
      expect(isAllowedBrowserOrigin("http://[::1]:4747")).toBe(true);
    });

    it("rejects non-loopback browser origins when auth is disabled", () => {
      expect(isAllowedBrowserOrigin("https://example.com")).toBe(false);
      expect(isAllowedBrowserOrigin("http://192.168.1.50:4747")).toBe(false);
      expect(isAllowedBrowserOrigin("null")).toBe(false);
    });

    it("rejects non-loopback origins when httpAuthEnabled is false", () => {
      expect(isAllowedBrowserOrigin("https://example.com", { httpAuthEnabled: false })).toBe(false);
    });

    it("allows any http(s) non-loopback origin when httpAuthEnabled is true", () => {
      expect(isAllowedBrowserOrigin("https://example.com", { httpAuthEnabled: true })).toBe(true);
      expect(isAllowedBrowserOrigin("http://192.168.1.50:4747", { httpAuthEnabled: true })).toBe(
        true
      );
    });

    it("still rejects non-http(s) origins even when httpAuthEnabled is true", () => {
      expect(isAllowedBrowserOrigin("file:///etc/passwd", { httpAuthEnabled: true })).toBe(false);
      expect(isAllowedBrowserOrigin("null", { httpAuthEnabled: true })).toBe(false);
    });

    it("treats malformed origins as rejected", () => {
      expect(isAllowedBrowserOrigin("not-a-url", { httpAuthEnabled: true })).toBe(false);
    });
  });

  describe("corsPreflightResponse", () => {
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

    it("accepts non-loopback origins once httpAuthEnabled is true", () => {
      const response = corsPreflightResponse(
        new Request("https://example.com/api/memories", {
          method: "OPTIONS",
          headers: {
            Origin: "https://example.com",
            "Access-Control-Request-Method": "POST",
          },
        }),
        { httpAuthEnabled: true }
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    });

    it("does not expose CORS headers on rejected origins", () => {
      const response = disallowedCorsResponse();

      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });
});
