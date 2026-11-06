import type { MemoryGroup, MemoryItem } from "./types";

function groupTime(group: MemoryGroup): number {
  const raw = group.isPair ? group.memory.createdAt : group.item.createdAt;
  return new Date(raw).getTime();
}

export function isGroupPinned(group: MemoryGroup): boolean {
  return group.isPair ? !!group.memory.isPinned : !!group.item.isPinned;
}

export function groupMemories(items: MemoryItem[]): MemoryGroup[] {
  const map = new Map(items.map((item) => [item.id, item]));
  const pairs: MemoryGroup[] = [];
  const paired = new Map<string, MemoryGroup>();
  const processed = new Set<string>();

  function pair(memory: MemoryItem | undefined, prompt: MemoryItem | undefined) {
    if (
      memory?.type !== "memory" ||
      prompt?.type !== "prompt" ||
      paired.has(memory.id) ||
      paired.has(prompt.id)
    ) {
      return;
    }
    const group: MemoryGroup = { isPair: true, memory, prompt };
    paired.set(memory.id, group);
    paired.set(prompt.id, group);
  }

  // Capture updates can leave older prompts pointing at the same memory.
  // Prefer the memory's current prompt before considering those backlinks.
  for (const item of map.values()) {
    if (item.type === "memory" && item.linkedPromptId) {
      pair(item, map.get(item.linkedPromptId));
    }
  }
  for (const item of map.values()) {
    if (item.type === "prompt" && item.linkedMemoryId) {
      pair(map.get(item.linkedMemoryId), item);
    }
  }

  // Emit each item once, retaining first-appearance order for equal dates.
  for (const item of map.values()) {
    if (processed.has(item.id)) continue;
    const group = paired.get(item.id);
    if (group?.isPair) {
      pairs.push(group);
      processed.add(group.memory.id);
      processed.add(group.prompt.id);
    } else {
      pairs.push({ isPair: false, type: item.type, item });
      processed.add(item.id);
    }
  }

  return pairs.sort((a, b) => {
    const pinA = isGroupPinned(a) ? 1 : 0;
    const pinB = isGroupPinned(b) ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    return groupTime(b) - groupTime(a);
  });
}

export function partitionPinnedGroups(groups: MemoryGroup[]): {
  pinned: MemoryGroup[];
  rest: MemoryGroup[];
} {
  const pinned: MemoryGroup[] = [];
  const rest: MemoryGroup[] = [];
  for (const group of groups) {
    (isGroupPinned(group) ? pinned : rest).push(group);
  }
  return { pinned, rest };
}
