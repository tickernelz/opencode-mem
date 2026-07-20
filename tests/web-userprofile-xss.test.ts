import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const MALICIOUS_DISPLAY_NAME = '<img src=x onerror="window.__xssFired=true">';

function loadRenderHarness(): {
  renderUserProfile: () => void;
  state: { userProfile: unknown };
  getHtml: () => string;
} {
  const source = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf-8");

  let capturedHtml = "";
  const profileContainer = {
    set innerHTML(value: string) {
      capturedHtml = value;
    },
    get innerHTML() {
      return capturedHtml;
    },
  };

  const escapingDiv = () => {
    let text = "";
    return {
      set textContent(value: string) {
        text = value;
      },
      get innerHTML() {
        return text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\"/g, "&quot;")
          .replace(/'/g, "&#039;");
      },
    };
  };

  const context = createContext({
    console,
    DOMPurify: { sanitize: (html: string) => html },
    getLanguage: () => "en",
    lucide: { createIcons: () => undefined },
    jsonrepair: undefined,
    marked: { parse: (markdown: string) => markdown, setOptions: () => undefined },
    t: (key: string) => key,
    document: {
      addEventListener: () => undefined,
      getElementById: (id: string) => (id === "profile-content" ? profileContainer : undefined),
      createElement: () => escapingDiv(),
    },
  });

  new Script(
    `${source}\n;globalThis.__renderUserProfile = renderUserProfile;\n;globalThis.__state = state;`
  ).runInContext(context);

  return {
    renderUserProfile: context.__renderUserProfile as () => void,
    state: context.__state as { userProfile: unknown },
    getHtml: () => capturedHtml,
  };
}

describe("web user-profile rendering", () => {
  it("escapes displayName in the profile header", () => {
    // Given: a stored user profile whose displayName came from an untrusted
    // per-project userNameOverride and contains an HTML event-handler payload.
    const { renderUserProfile, state, getHtml } = loadRenderHarness();
    state.userProfile = {
      exists: true,
      version: 1,
      totalPromptsAnalyzed: 0,
      lastAnalyzedAt: "2026-06-22T20:21:11.419Z",
      userId: "user_xss_repro",
      displayName: MALICIOUS_DISPLAY_NAME,
      profileData: {},
    };

    // When: the Web UI renders the User Profile tab.
    renderUserProfile();

    // Then: the payload is displayed as header text, not parsed as executable HTML.
    const html = getHtml();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img src=x");
  });
});
