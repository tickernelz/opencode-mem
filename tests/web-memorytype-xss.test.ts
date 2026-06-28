import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

type RenderMemoryCard = (memory: MemoryFixture) => string;
type RenderCombinedCard = (pair: CombinedCardFixture) => string;

type MemoryFixture = {
  id: string;
  content: string;
  memoryType: string;
  tags: readonly string[];
  createdAt: string;
  displayName: string;
  isPinned: boolean;
};

type PromptFixture = {
  id: string;
  content: string;
  createdAt: string;
};

type CombinedCardFixture = {
  memory: MemoryFixture;
  prompt: PromptFixture;
};

type RenderHarness = {
  renderMemoryCard: RenderMemoryCard;
  renderCombinedCard: RenderCombinedCard;
};

const MALICIOUS_MEMORY_TYPE = '</span><img src=x onerror="window.__xssFired=true"><span>';

function loadRenderHarness(): RenderHarness {
  const source = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf-8");
  const context = createContext({
    console,
    DOMPurify: { sanitize: (html: string) => html },
    getLanguage: () => "en",
    lucide: { createIcons: () => undefined },
    marked: { parse: (markdown: string) => markdown, setOptions: () => undefined },
    t: (key: string) => key,
    document: {
      addEventListener: () => undefined,
      createElement: () => {
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
      },
    },
  });

  new Script(
    `${source}\n;globalThis.__renderMemoryCard = renderMemoryCard;\n;globalThis.__renderCombinedCard = renderCombinedCard;`
  ).runInContext(context);

  return {
    renderMemoryCard: context.__renderMemoryCard as RenderMemoryCard,
    renderCombinedCard: context.__renderCombinedCard as RenderCombinedCard,
  };
}

function createMemory(): MemoryFixture {
  return {
    id: "mem_xss_repro",
    content: "benign content",
    memoryType: MALICIOUS_MEMORY_TYPE,
    tags: [],
    createdAt: "2026-06-22T20:21:11.419Z",
    displayName: "XSS repro memory",
    isPinned: false,
  };
}

function expectEscapedMemoryType(html: string): void {
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain('onerror="');
  expect(html).toContain("&lt;/span&gt;&lt;img src=x");
}

describe("web memoryType rendering", () => {
  it("escapes memoryType in standalone memory cards", () => {
    // Given: a stored memory with an HTML event-handler payload in memoryType.
    const { renderMemoryCard } = loadRenderHarness();
    const memory = createMemory();

    // When: the Web UI renders the standalone memory card.
    const html = renderMemoryCard(memory);

    // Then: the payload is displayed as badge text, not parsed as executable HTML.
    expectEscapedMemoryType(html);
  });

  it("escapes memoryType in combined prompt-memory cards", () => {
    // Given: a stored memory linked to a prompt with an HTML payload in memoryType.
    const { renderCombinedCard } = loadRenderHarness();
    const memory = createMemory();

    // When: the Web UI renders the combined prompt-memory card.
    const html = renderCombinedCard({
      memory,
      prompt: {
        id: "prompt_xss_repro",
        content: "remember this",
        createdAt: "2026-06-22T20:20:00.000Z",
      },
    });

    // Then: the payload is displayed as badge text, not parsed as executable HTML.
    expectEscapedMemoryType(html);
  });
});
