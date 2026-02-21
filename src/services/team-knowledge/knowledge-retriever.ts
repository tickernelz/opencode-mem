// src/services/team-knowledge/knowledge-retriever.ts

import { knowledgeStore } from "./knowledge-store.js";
import type { KnowledgeType, KnowledgeItem } from "../../types/team-knowledge.js";

/**
 * Get a concise overview context for AI injection
 * Includes top tech stack, standards, and architecture items
 */
export async function getOverviewContext(containerTag: string): Promise<string> {
  // Note: knowledgeStore.list() internally converts to team tag
  const techStack = await knowledgeStore.list(containerTag, "tech-stack", 2);
  const standards = await knowledgeStore.list(containerTag, "coding-standard", 2);
  const architecture = await knowledgeStore.list(containerTag, "architecture", 1);

  if (techStack.length === 0 && standards.length === 0 && architecture.length === 0) {
    return "";
  }

  const sections: string[] = ["## Team Knowledge"];

  if (techStack.length > 0) {
    const techSummary = techStack.map((t) => t.title).join(", ");
    sections.push(`**Tech Stack**: ${techSummary}`);
  }

  if (standards.length > 0) {
    const standardsSummary = standards.map((s) => s.title).join(", ");
    sections.push(`**Coding Standards**: ${standardsSummary}`);
  }

  if (architecture.length > 0) {
    const archSummary = architecture.map((a) => a.title).join(", ");
    sections.push(`**Architecture**: ${archSummary}`);
  }

  return sections.join("\n");
}

/**
 * Search and retrieve relevant knowledge based on query
 * Returns formatted markdown for AI context injection
 */
export async function getRelevantKnowledge(
  query: string,
  containerTag: string,
  options: { limit?: number; types?: KnowledgeType[] } = {}
): Promise<string> {
  const { limit = 3, types } = options;

  const results = await knowledgeStore.search(query, containerTag, {
    threshold: 0.6,
    limit: limit * 2, // Get extra for filtering
  });

  // Filter by types if specified
  let filtered = results;
  if (types && types.length > 0) {
    filtered = results.filter((r) => types.includes(r.item.type));
  }

  const topResults = filtered.slice(0, limit);

  if (topResults.length === 0) {
    return "";
  }

  const sections: string[] = ["## Relevant Team Knowledge"];

  for (const result of topResults) {
    const { item, similarity } = result;
    sections.push(`### ${item.title} (${Math.round(similarity * 100)}% match)`);

    // Truncate content if too long
    const content = item.content.length > 500 ? item.content.slice(0, 500) + "..." : item.content;

    sections.push(content);
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Format a single knowledge item for display
 * Returns detailed markdown representation
 */
export async function formatKnowledgeItem(item: KnowledgeItem): Promise<string> {
  return `### ${item.title}

**Type**: ${item.type}
**Source**: ${item.sourceFile || "N/A"}
**Confidence**: ${Math.round(item.confidence * 100)}%
**Version**: ${item.version}
**Updated**: ${new Date(item.updatedAt).toISOString()}

${item.content}

**Tags**: ${item.tags.join(", ") || "None"}
`;
}
