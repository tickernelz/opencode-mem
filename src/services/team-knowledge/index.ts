// src/services/team-knowledge/index.ts

export { knowledgeStore, getTeamContainerTag } from "./knowledge-store.js";
export { syncTeamKnowledge, getLastSyncTime, isSyncing } from "./knowledge-sync.js";
export {
  getOverviewContext,
  getRelevantKnowledge,
  formatKnowledgeItem,
} from "./knowledge-retriever.js";
export { allExtractors, ruleExtractors, aiExtractors } from "./extractors/index.js";
export { BaseExtractor } from "./extractors/base-extractor.js";
export type { ExtractorConfig } from "./extractors/base-extractor.js";
