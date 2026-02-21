// src/services/team-knowledge/extractors/business-logic-extractor.ts

import { BaseExtractor } from "./base-extractor.js";
import type { KnowledgeExtractResult } from "../../../types/team-knowledge.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { CONFIG } from "../../../config.js";
import { log } from "../../logger.js";

export class BusinessLogicExtractor extends BaseExtractor {
  readonly type = "business-logic" as const;
  readonly sourceType = "code" as const;

  private readonly corePatterns = [
    /src\/(services?|domain|core|business|usecases?|application)/i,
    /src\/.*\/(service|handler|processor|manager|engine)/i,
  ];

  private readonly codeExtensions = new Set([".ts", ".js", ".tsx", ".jsx"]);

  async extract(directory: string): Promise<KnowledgeExtractResult> {
    const items: KnowledgeExtractResult["items"] = [];
    const errors: string[] = [];

    try {
      // Find core business files
      const coreFiles = this.findCoreFiles(directory);

      if (coreFiles.length === 0) {
        return { items, errors };
      }

      // Extract JSDoc/comments from core files
      for (const file of coreFiles.slice(0, 10)) {
        const docItems = await this.extractFromFile(directory, file);
        items.push(...docItems);
      }

      // If AI is configured and we have content, generate summary
      if (CONFIG.memoryModel && CONFIG.memoryApiUrl && items.length > 0) {
        const aiSummary = await this.generateAISummary(items);
        if (aiSummary) {
          items.unshift(aiSummary);
        }
      }
    } catch (e) {
      errors.push(`Business logic extraction failed: ${e}`);
      log("Business logic extraction error", { error: String(e) });
    }

    return { items, errors };
  }

  private findCoreFiles(directory: string): string[] {
    const coreFiles: string[] = [];

    const scanDir = (dir: string, relativePath: string = "") => {
      try {
        const entries = readdirSync(dir);

        for (const entry of entries) {
          if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;

          const fullPath = join(dir, entry);
          const relPath = relativePath ? `${relativePath}/${entry}` : entry;

          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            scanDir(fullPath, relPath);
          } else if (this.codeExtensions.has(extname(entry))) {
            for (const pattern of this.corePatterns) {
              if (pattern.test(relPath)) {
                coreFiles.push(relPath);
                break;
              }
            }
          }
        }
      } catch {
        // Ignore errors
      }
    };

    scanDir(directory);
    return coreFiles;
  }

  private async extractFromFile(
    directory: string,
    relativePath: string
  ): Promise<KnowledgeExtractResult["items"]> {
    const filePath = join(directory, relativePath);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf-8");
    const items: KnowledgeExtractResult["items"] = [];

    // Extract JSDoc comments
    const jsdocPattern = /\/\*\*[\s\S]*?\*\//g;
    const jsdocs = content.match(jsdocPattern) || [];

    for (const doc of jsdocs.slice(0, 5)) {
      if (doc.length < 50) continue;

      const description = doc
        .replace(/\/\*\*|\*\//g, "")
        .replace(/^\s*\*\s?/gm, "")
        .replace(/@\w+.*$/gm, "")
        .trim();

      if (description.length > 30) {
        items.push(
          this.createItem(
            `${relativePath} Documentation`,
            `## ${relativePath}\n\n${description}`,
            relativePath,
            ["documentation", "jsdoc"],
            0.7,
            `jsdoc-${items.length}`
          )
        );
      }
    }

    // Extract TypeScript interfaces/types
    if (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) {
      const interfacePattern = /(?:\/\*\*[\s\S]*?\*\/\s*)?(export\s+)?(?:interface|type)\s+(\w+)/g;
      let match;

      while ((match = interfacePattern.exec(content)) !== null) {
        const typeName = match[2];
        if (typeName && typeName.length > 2) {
          const startIdx = match.index;
          const endIdx = content.indexOf("}", startIdx) + 1;

          if (endIdx > startIdx && endIdx - startIdx < 500) {
            const typeContent = content.slice(startIdx, endIdx);

            items.push(
              this.createItem(
                `Type: ${typeName}`,
                `## Type Definition: ${typeName}\n\n\`\`\`typescript\n${typeContent}\n\`\`\``,
                relativePath,
                ["type", "interface", "model"],
                0.65,
                `type-${typeName}`
              )
            );
          }
        }
      }
    }

    return items;
  }

  private async generateAISummary(
    items: KnowledgeExtractResult["items"]
  ): Promise<KnowledgeExtractResult["items"][0] | null> {
    if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) return null;

    try {
      const { AIProviderFactory } = await import("../../ai/ai-provider-factory.js");

      const providerConfig = {
        model: CONFIG.memoryModel,
        apiUrl: CONFIG.memoryApiUrl,
        apiKey: CONFIG.memoryApiKey,
        maxIterations: 1,
        iterationTimeout: CONFIG.autoCaptureIterationTimeout,
      };

      const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

      const docSummaries = items
        .slice(0, 10)
        .map((item) => `### ${item.title}\n${item.content.slice(0, 200)}`)
        .join("\n\n");

      const systemPrompt = `You are a technical documentation curator. Create a high-level business logic overview.

OUTPUT FORMAT (JSON):
{
  "title": "Business Logic Overview",
  "summary": "Markdown summary of core business concepts and flows (3-5 paragraphs)",
  "tags": ["tag1", "tag2", "tag3"]
}`;

      const userPrompt = `Based on these code documentation excerpts, create a high-level summary of the business logic:

${docSummaries}

Return JSON with summary.`;

      const toolSchema = {
        type: "function" as const,
        function: {
          name: "save_summary",
          description: "Save business logic summary",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["title", "summary", "tags"],
          },
        },
      };

      const result = await provider.executeToolCall(
        systemPrompt,
        userPrompt,
        toolSchema,
        "business-logic-summary"
      );

      if (!result.success || !result.data) {
        return null;
      }

      return this.createItem(
        result.data.title || "Business Logic Overview",
        `## ${result.data.title}\n\n${result.data.summary}`,
        "core-files",
        (result.data.tags || []).map((t: string) => t.toLowerCase()),
        0.8,
        "overview"
      );
    } catch {
      return null;
    }
  }
}

export const businessLogicExtractor = new BusinessLogicExtractor();
