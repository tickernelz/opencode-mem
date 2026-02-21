// src/services/team-knowledge/extractors/index.ts

import { techStackExtractor, TechStackExtractor } from "./tech-stack-extractor.js";
import { architectureExtractor, ArchitectureExtractor } from "./architecture-extractor.js";
import { codingStandardExtractor, CodingStandardExtractor } from "./coding-standard-extractor.js";
import { lessonExtractor, LessonExtractor } from "./lesson-extractor.js";
import { businessLogicExtractor, BusinessLogicExtractor } from "./business-logic-extractor.js";

export { BaseExtractor } from "./base-extractor.js";
export type { ExtractorConfig } from "./base-extractor.js";

export { techStackExtractor, TechStackExtractor };
export { architectureExtractor, ArchitectureExtractor };
export { codingStandardExtractor, CodingStandardExtractor };
export { lessonExtractor, LessonExtractor };
export { businessLogicExtractor, BusinessLogicExtractor };

// Aggregate all rule-based extractors
export const ruleExtractors = [techStackExtractor, architectureExtractor, codingStandardExtractor];

// AI-enhanced extractors (only runs if AI is configured)
export const aiExtractors = [lessonExtractor, businessLogicExtractor];

// All extractors combined
export const allExtractors = [...ruleExtractors, ...aiExtractors];
