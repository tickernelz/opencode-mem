// src/services/team-knowledge/extractors/base-extractor.ts

import type {
  KnowledgeType,
  KnowledgeSourceType,
  KnowledgeExtractResult,
} from "../../../types/team-knowledge.js";
import { createHash } from "node:crypto";

export interface ExtractorConfig {
  enabled: boolean;
}

export abstract class BaseExtractor {
  abstract readonly type: KnowledgeType;
  abstract readonly sourceType: KnowledgeSourceType;

  protected config: ExtractorConfig;

  constructor(config: Partial<ExtractorConfig> = {}) {
    this.config = {
      enabled: true,
      ...config,
    };
  }

  abstract extract(directory: string): Promise<KnowledgeExtractResult>;

  protected generateSourceKey(sourceFile: string, sectionId: string = ""): string {
    const input = `${this.type}:${sourceFile}:${sectionId}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  protected createItem(
    title: string,
    content: string,
    sourceFile: string,
    tags: string[],
    confidence: number = 0.8,
    sectionId: string = ""
  ) {
    return {
      type: this.type,
      title,
      content,
      sourceKey: this.generateSourceKey(sourceFile, sectionId),
      sourceFile,
      sourceType: this.sourceType,
      confidence,
      tags,
    };
  }
}
