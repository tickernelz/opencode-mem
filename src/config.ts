import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "./services/jsonc.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const DATA_DIR = join(homedir(), ".opencode-mem");
const CONFIG_FILES = [
  join(CONFIG_DIR, "opencode-mem.jsonc"),
  join(CONFIG_DIR, "opencode-mem.json"),
];

if (!existsSync(CONFIG_DIR)) {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

interface OpenCodeMemConfig {
  storagePath?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  similarityThreshold?: number;
  maxMemories?: number;
  maxProjectMemories?: number;
  maxProfileItems?: number;
  injectProfile?: boolean;
  containerTagPrefix?: string;
  keywordPatterns?: string[];
  autoCaptureEnabled?: boolean;
  autoCaptureTokenThreshold?: number;
  autoCaptureMinTokens?: number;
  autoCaptureMaxMemories?: number;
  autoCaptureSummaryMaxLength?: number;
  autoCaptureContextWindow?: number;
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
  webServerEnabled?: boolean;
  webServerPort?: number;
  webServerHost?: string;
  maxVectorsPerShard?: number;
  autoCleanupEnabled?: boolean;
  autoCleanupRetentionDays?: number;
  deduplicationEnabled?: boolean;
  deduplicationSimilarityThreshold?: number;
}

const DEFAULT_KEYWORD_PATTERNS = [
  "remember",
  "memorize",
  "save\\s+this",
  "note\\s+this",
  "keep\\s+in\\s+mind",
  "don'?t\\s+forget",
  "learn\\s+this",
  "store\\s+this",
  "record\\s+this",
  "make\\s+a\\s+note",
  "take\\s+note",
  "jot\\s+down",
  "commit\\s+to\\s+memory",
  "remember\\s+that",
  "never\\s+forget",
  "always\\s+remember",
];

const DEFAULTS: Required<
  Omit<
    OpenCodeMemConfig,
    "embeddingApiUrl" | "embeddingApiKey" | "memoryModel" | "memoryApiUrl" | "memoryApiKey"
  >
> & {
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
} = {
  storagePath: join(DATA_DIR, "data"),
  embeddingModel: "Xenova/nomic-embed-text-v1",
  embeddingDimensions: 768,
  similarityThreshold: 0.6,
  maxMemories: 5,
  maxProjectMemories: 10,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "opencode",
  keywordPatterns: [],
  autoCaptureEnabled: true,
  autoCaptureTokenThreshold: 10000,
  autoCaptureMinTokens: 20000,
  autoCaptureMaxMemories: 10,
  autoCaptureSummaryMaxLength: 0,
  autoCaptureContextWindow: 3,
  webServerEnabled: true,
  webServerPort: 4747,
  webServerHost: "127.0.0.1",
  maxVectorsPerShard: 50000,
  autoCleanupEnabled: true,
  autoCleanupRetentionDays: 30,
  deduplicationEnabled: true,
  deduplicationSimilarityThreshold: 0.9,
};

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

function loadConfig(): OpenCodeMemConfig {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const json = stripJsoncComments(content);
        return JSON.parse(json) as OpenCodeMemConfig;
      } catch {}
    }
  }
  return {};
}

const fileConfig = loadConfig();

const CONFIG_TEMPLATE = `{
  // ============================================
  // OpenCode Memory Plugin Configuration
  // ============================================
  
  // Storage location for vector database
  "storagePath": "~/.opencode-mem/data",
  
  // ============================================
  // Embedding Model (for similarity search)
  // ============================================
  
  // Default: Nomic Embed v1 (768 dimensions, 8192 context, multilingual)
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  
  // Auto-detected dimensions (no need to set manually)
  // "embeddingDimensions": 768,
  
  // Other recommended models:
  // "embeddingModel": "Xenova/jina-embeddings-v2-base-en",  // 768 dims, English-only, 8192 context
  // "embeddingModel": "Xenova/jina-embeddings-v2-small-en", // 512 dims, faster, 8192 context
  // "embeddingModel": "Xenova/all-MiniLM-L6-v2",            // 384 dims, very fast, 512 context
  // "embeddingModel": "Xenova/all-mpnet-base-v2",           // 768 dims, good quality, 512 context
  
  // Optional: Use OpenAI-compatible API for embeddings
  // "embeddingApiUrl": "https://api.openai.com/v1",
  // "embeddingApiKey": "sk-...",
  
  // ============================================
  // Web Server Settings
  // ============================================
  
  "webServerEnabled": true,
  "webServerPort": 4747,
  "webServerHost": "127.0.0.1",
  
  // ============================================
  // Database Settings
  // ============================================
  
  "maxVectorsPerShard": 50000,
  "autoCleanupEnabled": true,
  "autoCleanupRetentionDays": 30,
  "deduplicationEnabled": true,
  "deduplicationSimilarityThreshold": 0.90,
  
  // ============================================
  // Auto-Capture Settings (REQUIRES EXTERNAL API)
  // ============================================
  
  // IMPORTANT: Auto-capture ONLY works with external API
  // It runs in background without blocking your main session
  // Note: Ollama may not support tool calling. Use OpenAI, Anthropic, or Groq for best results.
  
  "autoCaptureEnabled": true,
  
  // REQUIRED for auto-capture (all 3 must be set):
  "memoryModel": "gpt-4o-mini",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-...",
  
  // Examples for other providers:
  // Anthropic: 
  //   "memoryModel": "claude-3-5-haiku-20241022"
  //   "memoryApiUrl": "https://api.anthropic.com/v1"
  //   "memoryApiKey": "sk-ant-..."
  // Groq (fast & cheap): 
  //   "memoryModel": "llama-3.3-70b-versatile"
  //   "memoryApiUrl": "https://api.groq.com/openai/v1"
  //   "memoryApiKey": "gsk_..."
  
  // Token thresholds
  "autoCaptureTokenThreshold": 10000,
  "autoCaptureMinTokens": 20000,
  "autoCaptureMaxMemories": 10,
  "autoCaptureContextWindow": 3,
  
  // Summary length: 0 = AI decides optimal length, >0 = character limit
  "autoCaptureSummaryMaxLength": 0,
  
  // ============================================
  // Search Settings
  // ============================================
  
  "similarityThreshold": 0.6,
  "maxMemories": 5,
  "maxProjectMemories": 10,
  
  // ============================================
  // Advanced Settings
  // ============================================
  
  "injectProfile": true,
  "keywordPatterns": []
}
`;

function ensureConfigExists(): void {
  const configPath = join(CONFIG_DIR, "opencode-mem.jsonc");

  if (!existsSync(configPath)) {
    try {
      writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
      console.log(`\n✓ Created config template: ${configPath}`);
      console.log("  Edit this file to customize opencode-mem settings.\n");
    } catch {}
  }
}

ensureConfigExists();

function getEmbeddingDimensions(model: string): number {
  const dimensionMap: Record<string, number> = {
    "Xenova/nomic-embed-text-v1": 768,
    "Xenova/nomic-embed-text-v1-unsupervised": 768,
    "Xenova/nomic-embed-text-v1-ablated": 768,
    "Xenova/jina-embeddings-v2-base-en": 768,
    "Xenova/jina-embeddings-v2-base-zh": 768,
    "Xenova/jina-embeddings-v2-base-de": 768,
    "Xenova/jina-embeddings-v2-small-en": 512,
    "Xenova/all-MiniLM-L6-v2": 384,
    "Xenova/all-MiniLM-L12-v2": 384,
    "Xenova/all-mpnet-base-v2": 768,
    "Xenova/bge-base-en-v1.5": 768,
    "Xenova/bge-small-en-v1.5": 384,
    "Xenova/gte-small": 384,
    "Xenova/GIST-small-Embedding-v0": 384,
    "Xenova/text-embedding-ada-002": 1536,
  };
  return dimensionMap[model] || 768;
}

export const CONFIG = {
  storagePath: expandPath(fileConfig.storagePath ?? DEFAULTS.storagePath),
  embeddingModel: fileConfig.embeddingModel ?? DEFAULTS.embeddingModel,
  embeddingDimensions:
    fileConfig.embeddingDimensions ??
    getEmbeddingDimensions(fileConfig.embeddingModel ?? DEFAULTS.embeddingModel),
  embeddingApiUrl: fileConfig.embeddingApiUrl,
  embeddingApiKey: fileConfig.embeddingApiKey ?? process.env.OPENAI_API_KEY,
  similarityThreshold: fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  maxProjectMemories: fileConfig.maxProjectMemories ?? DEFAULTS.maxProjectMemories,
  maxProfileItems: fileConfig.maxProfileItems ?? DEFAULTS.maxProfileItems,
  injectProfile: fileConfig.injectProfile ?? DEFAULTS.injectProfile,
  containerTagPrefix: fileConfig.containerTagPrefix ?? DEFAULTS.containerTagPrefix,
  keywordPatterns: [
    ...DEFAULT_KEYWORD_PATTERNS,
    ...(fileConfig.keywordPatterns ?? []).filter(isValidRegex),
  ],
  autoCaptureEnabled: fileConfig.autoCaptureEnabled ?? DEFAULTS.autoCaptureEnabled,
  autoCaptureTokenThreshold:
    fileConfig.autoCaptureTokenThreshold ?? DEFAULTS.autoCaptureTokenThreshold,
  autoCaptureMinTokens: fileConfig.autoCaptureMinTokens ?? DEFAULTS.autoCaptureMinTokens,
  autoCaptureMaxMemories: fileConfig.autoCaptureMaxMemories ?? DEFAULTS.autoCaptureMaxMemories,
  autoCaptureSummaryMaxLength:
    fileConfig.autoCaptureSummaryMaxLength ?? DEFAULTS.autoCaptureSummaryMaxLength,
  autoCaptureContextWindow:
    fileConfig.autoCaptureContextWindow ?? DEFAULTS.autoCaptureContextWindow,
  memoryModel: fileConfig.memoryModel,
  memoryApiUrl: fileConfig.memoryApiUrl,
  memoryApiKey: fileConfig.memoryApiKey,
  webServerEnabled: fileConfig.webServerEnabled ?? DEFAULTS.webServerEnabled,
  webServerPort: fileConfig.webServerPort ?? DEFAULTS.webServerPort,
  webServerHost: fileConfig.webServerHost ?? DEFAULTS.webServerHost,
  maxVectorsPerShard: fileConfig.maxVectorsPerShard ?? DEFAULTS.maxVectorsPerShard,
  autoCleanupEnabled: fileConfig.autoCleanupEnabled ?? DEFAULTS.autoCleanupEnabled,
  autoCleanupRetentionDays:
    fileConfig.autoCleanupRetentionDays ?? DEFAULTS.autoCleanupRetentionDays,
  deduplicationEnabled: fileConfig.deduplicationEnabled ?? DEFAULTS.deduplicationEnabled,
  deduplicationSimilarityThreshold:
    fileConfig.deduplicationSimilarityThreshold ?? DEFAULTS.deduplicationSimilarityThreshold,
};

export function isConfigured(): boolean {
  return true;
}
