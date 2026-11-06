import { describe, expect, test } from "bun:test";
import { deleteSelectedMemories } from "../web/src/lib/bulk-delete";
import { groupMemories, partitionPinnedGroups } from "../web/src/lib/group-memories";
import type { MemoryGroup, MemoryItem } from "../src/shared/api";

function memory(id: string, linkedPromptId?: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    type: "memory",
    content: id,
    createdAt: "2026-01-01T00:00:00Z",
    linkedPromptId,
    ...extra,
  };
}

function prompt(id: string, linkedMemoryId?: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    type: "prompt",
    content: id,
    createdAt: "2026-01-01T00:00:00Z",
    linkedMemoryId,
    ...extra,
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest])
  );
}

function keys(groups: MemoryGroup[]): string[] {
  return groups.map((group) => (group.isPair ? group.memory.id : group.item.id));
}

function expectPartition(items: MemoryItem[]): MemoryGroup[] {
  const groups = groupMemories(items);
  const members = groups.flatMap((group) =>
    group.isPair ? [group.memory.id, group.prompt.id] : [group.item.id]
  );
  expect(members.toSorted()).toEqual([...new Set(items.map((item) => item.id))].toSorted());
  expect(new Set(keys(groups)).size).toBe(groups.length);
  for (const group of groups) {
    if (group.isPair) {
      expect(group.memory.type).toBe("memory");
      expect(group.prompt.type).toBe("prompt");
    }
  }
  return groups;
}

describe("groupMemories", () => {
  test("handles an empty page", () => {
    expect(groupMemories([])).toEqual([]);
  });

  test("keeps an ordinary bidirectional pair in either input order", () => {
    const items = [memory("mem_1", "prompt_1"), prompt("prompt_1", "mem_1")];
    for (const order of permutations(items)) {
      expect(expectPartition(order)).toEqual([
        { isPair: true, memory: items[0], prompt: items[1] },
      ]);
    }
  });

  test("prefers the current capture prompt and keeps older prompts visible in every order", () => {
    const currentMemory = memory("mem_1", "prompt_new");
    const oldPrompt = prompt("prompt_old", "mem_1");
    const newPrompt = prompt("prompt_new", "mem_1");
    for (const order of permutations([currentMemory, oldPrompt, newPrompt])) {
      const groups = expectPartition(order);
      expect(groups).toContainEqual({ isPair: true, memory: currentMemory, prompt: newPrompt });
      expect(groups).toContainEqual({ isPair: false, type: "prompt", item: oldPrompt });
      expect(new Set(keys(groups))).toEqual(new Set(["mem_1", "prompt_old"]));
    }
  });

  test("pairs a prompt backlink even when a memory without promptId appears first", () => {
    const items = [memory("mem_1"), prompt("prompt_1", "mem_1")];
    for (const order of permutations(items)) {
      expect(expectPartition(order)).toEqual([
        { isPair: true, memory: items[0], prompt: items[1] },
      ]);
    }
  });

  test("pairs a memory forward link even when an unlinked prompt appears first", () => {
    const items = [memory("mem_1", "prompt_1"), prompt("prompt_1")];
    for (const order of permutations(items)) {
      expect(expectPartition(order)).toEqual([
        { isPair: true, memory: items[0], prompt: items[1] },
      ]);
    }
  });

  test("uses a prompt at most once when two memories claim it", () => {
    for (const order of permutations([
      memory("mem_1", "prompt_1"),
      memory("mem_2", "prompt_1"),
      prompt("prompt_1"),
    ])) {
      expect(expectPartition(order)).toHaveLength(2);
    }
  });

  test("preserves every item when several prompts claim a memory without a backlink", () => {
    for (const order of permutations([
      memory("mem_1"),
      prompt("prompt_1", "mem_1"),
      prompt("prompt_2", "mem_1"),
    ])) {
      expect(expectPartition(order)).toHaveLength(2);
    }
  });

  test("handles all page subsets without requiring linked items on that page", () => {
    const items = [
      memory("mem_1", "prompt_new"),
      prompt("prompt_old", "mem_1"),
      prompt("prompt_new", "mem_1"),
    ];
    for (let mask = 0; mask < 1 << items.length; mask++) {
      for (const order of permutations(items.filter((_, index) => mask & (1 << index)))) {
        expectPartition(order);
      }
    }
  });

  test("uses an available older prompt when the current prompt is outside the page", () => {
    const m = memory("mem_1", "prompt_new_off_page");
    const p = prompt("prompt_old", "mem_1");
    for (const order of permutations([m, p])) {
      expect(expectPartition(order)).toEqual([{ isPair: true, memory: m, prompt: p }]);
    }
  });

  test("grouped bulk selection does not delete a shared memory twice", async () => {
    const items = [
      memory("mem_1", "prompt_new"),
      prompt("prompt_old", "mem_1"),
      prompt("prompt_new", "mem_1"),
    ];
    const calls: Array<{ endpoint: string; body: unknown }> = [];
    const result = await deleteSelectedMemories(
      keys(expectPartition(items)),
      async (endpoint, options) => {
        calls.push({ endpoint, body: JSON.parse(String(options.body)) });
        return { success: true };
      },
      items
    );
    expect(result).toEqual({ success: true, deletedIds: ["prompt_old", "mem_1"] });
    expect(calls).toEqual([
      { endpoint: "/api/prompts/bulk-delete", body: { ids: ["prompt_old"], cascade: true } },
    ]);
  });

  test("leaves missing, self, and wrong-type links as standalone items", () => {
    const items = [
      memory("mem_missing", "absent"),
      prompt("prompt_missing", "absent"),
      memory("mem_self", "mem_self"),
      prompt("prompt_self", "prompt_self"),
      memory("mem_wrong", "mem_missing"),
      prompt("prompt_wrong", "prompt_missing"),
    ];
    expect(expectPartition(items).every((group) => !group.isPair)).toBe(true);
  });

  test("deduplicates repeated input IDs", () => {
    const m = memory("mem_1", "prompt_1");
    const p = prompt("prompt_1", "mem_1");
    expect(expectPartition([m, p, m, p])).toHaveLength(1);
  });

  test("retains pinned-first and memory-createdAt ordering", () => {
    const groups = expectPartition([
      memory("mem_old", undefined, { createdAt: "2024-01-01T00:00:00Z" }),
      memory("mem_new", undefined, { createdAt: "2025-01-01T00:00:00Z" }),
      memory("mem_pinned", "prompt_pinned", { isPinned: true, createdAt: "2023-01-01T00:00:00Z" }),
      prompt("prompt_pinned", "mem_pinned", { createdAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(keys(groups)).toEqual(["mem_pinned", "mem_new", "mem_old"]);
    const partitioned = partitionPinnedGroups(groups);
    expect(keys(partitioned.pinned)).toEqual(["mem_pinned"]);
    expect(keys(partitioned.rest)).toEqual(["mem_new", "mem_old"]);
  });

  test("keeps first-appearance order when group dates tie", () => {
    const items = [
      memory("mem_solo"),
      prompt("prompt_pair", "mem_pair"),
      memory("mem_pair", "prompt_pair"),
    ];
    expect(keys(expectPartition(items))).toEqual(["mem_solo", "mem_pair"]);
    expect(keys(expectPartition(items.toReversed()))).toEqual(["mem_pair", "mem_solo"]);
  });

  test("does not mutate input links or ordering", () => {
    const items = [
      memory("mem_1", "prompt_new"),
      prompt("prompt_old", "mem_1"),
      prompt("prompt_new", "mem_1"),
    ];
    const before = structuredClone(items);
    items.forEach(Object.freeze);
    expectPartition(items);
    expect(items).toEqual(before);
  });

  test("partitions every two-memory/two-prompt link combination in every order", () => {
    for (const a of [undefined, "prompt_1", "prompt_2"]) {
      for (const b of [undefined, "prompt_1", "prompt_2"]) {
        for (const c of [undefined, "mem_1", "mem_2"]) {
          for (const d of [undefined, "mem_1", "mem_2"]) {
            for (const order of permutations([
              memory("mem_1", a),
              memory("mem_2", b),
              prompt("prompt_1", c),
              prompt("prompt_2", d),
            ])) {
              expectPartition(order);
            }
          }
        }
      }
    }
  });
});
