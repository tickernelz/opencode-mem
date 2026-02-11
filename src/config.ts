import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "./services/jsonc.js";
import { resolveSecretValue } from "./services/secret-resolver.js";

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
  customSqlitePath?: string;
  userEmailOverride?: string;
  userNameOverride?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  similarityThreshold?: number;
  maxMemories?: number;
  maxProfileItems?: number;
  injectProfile?: boolean;
  containerTagPrefix?: string;
  autoCaptureEnabled?: boolean;
  autoCaptureMaxIterations?: number;
  autoCaptureIterationTimeout?: number;
  autoCaptureLanguage?: string;
  memoryProvider?: "openai-chat" | "openai-responses" | "anthropic";
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
  memoryTemperature?: number | false;
  aiSessionRetentionDays?: number;
  webServerEnabled?: boolean;
  webServerPort?: number;
  webServerHost?: string;
  maxVectorsPerShard?: number;
  autoCleanupEnabled?: boolean;
  autoCleanupRetentionDays?: number;
  deduplicationEnabled?: boolean;
  deduplicationSimilarityThreshold?: number;
  userProfileAnalysisInterval?: number;
  userProfileMaxPreferences?: number;
  userProfileMaxPatterns?: number;
  userProfileMaxWorkflows?: number;
  userProfileConfidenceDecayDays?: number;
  userProfileChangelogRetentionCount?: number;
  showAutoCaptureToasts?: boolean;
  showUserProfileToasts?: boolean;
  showErrorToasts?: boolean;
  compaction?: {
    enabled?: boolean;
    memoryLimit?: number;
  };
  chatMessage?: {
    enabled?: boolean;
    maxMemories?: number;
    excludeCurrentSession?: boolean;
    maxAgeDays?: number;
    injectOn?: "first" | "always";
  };
}

const DEFAULTS: Required<
  Omit<
    OpenCodeMemConfig,
    | "embeddingApiUrl"
    | "embeddingApiKey"
    | "memoryModel"
    | "memoryApiUrl"
    | "memoryApiKey"
    | "memoryProvider"
    | "memoryTemperature"
    | "customSqlitePath"
    | "autoCaptureLanguage"
    | "userEmailOverride"
    | "userNameOverride"
  >
> & {
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
  memoryProvider?: "openai-chat" | "openai-responses" | "anthropic";
  memoryTemperature?: number | false;
  customSqlitePath?: string;
  autoCaptureLanguage?: string;
  userEmailOverride?: string;
  userNameOverride?: string;
} = {
  storagePath: join(DATA_DIR, "data"),
  embeddingModel: "Xenova/nomic-embed-text-v1",
  embeddingDimensions: 768,
  similarityThreshold: 0.6,
  maxMemories: 10,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "opencode",
  autoCaptureEnabled: true,
  autoCaptureMaxIterations: 5,
  autoCaptureIterationTimeout: 30000,
  aiSessionRetentionDays: 7,
  webServerEnabled: true,
  webServerPort: 4747,
  webServerHost: "127.0.0.1",
  maxVectorsPerShard: 50000,
  autoCleanupEnabled: true,
  autoCleanupRetentionDays: 30,
  deduplicationEnabled: true,
  deduplicationSimilarityThreshold: 0.9,
  userProfileAnalysisInterval: 10,
  userProfileMaxPreferences: 20,
  userProfileMaxPatterns: 15,
  userProfileMaxWorkflows: 10,
  userProfileConfidenceDecayDays: 30,
  userProfileChangelogRetentionCount: 5,
  showAutoCaptureToasts: true,
  showUserProfileToasts: true,
  showErrorToasts: true,
  compaction: {
    enabled: true,
    memoryLimit: 10,
  },
  chatMessage: {
    enabled: true,
    maxMemories: 3,
    excludeCurrentSession: true,
    maxAgeDays: undefined,
    injectOn: "first",
  },
};

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

  "userEmailOverride": "",
  "userNameOverride": "",
  
  // ============================================
  // macOS SQLite Extension Loading (REQUIRED FOR macOS)
  // ============================================
  
  // macOS users MUST set this to use Homebrew SQLite instead of Apple's SQLite
  // Apple's SQLite disables extension loading which breaks sqlite-vec
  // 
  // Common paths:
  // - Homebrew (Intel):      "/usr/local/opt/sqlite/lib/libsqlite3.dylib"
  // - Homebrew (Apple Silicon): "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"
  // 
  // To install: brew install sqlite
  // To find path: brew --prefix sqlite
  // 
  // "customSqlitePath": "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  
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
  
  // Enable web UI for managing memories (accessible at http://localhost:4747)
  "webServerEnabled": true,
  
  // Port for web UI server
  "webServerPort": 4747,
  
  // Host address for web UI (use 127.0.0.1 for local only, 0.0.0.0 for network access)
  "webServerHost": "127.0.0.1",
  
  // ============================================
  // Database Settings
  // ============================================
  
  // Maximum vectors per database shard (auto-creates new shard when limit reached)
  "maxVectorsPerShard": 50000,
  
  // Automatically delete old memories based on retention period
  "autoCleanupEnabled": true,
  
  // Days to keep memories before auto-cleanup (only if autoCleanupEnabled is true)
  "autoCleanupRetentionDays": 30,
  
  // Automatically detect and remove duplicate memories
  "deduplicationEnabled": true,
  
  // Similarity threshold (0-1) for detecting duplicates (higher = stricter)
  "deduplicationSimilarityThreshold": 0.90,
  
  // ============================================
  // Auto-Capture Settings (REQUIRES EXTERNAL API)
  // ============================================
  
  // IMPORTANT: Auto-capture ONLY works with external API
  // It runs in background without blocking your main session
  // Note: Ollama may not support tool calling. Use OpenAI, Anthropic, or Groq for best results.
  
  "autoCaptureEnabled": true,
  
  // Provider type: "openai-chat" | "openai-responses" | "anthropic"
  "memoryProvider": "openai-chat",
  
  // REQUIRED for auto-capture (all 3 must be set):
  "memoryModel": "gpt-4o-mini",
  "memoryApiUrl": "https://api.openai.com/v1",
  "memoryApiKey": "sk-...",

  // API Key Formats:
  // Direct value:        "sk-..."
  // From file:           "file://~/.config/litellm-key.txt"
  // From env variable:   "env://LITELLM_API_KEY"
  
  // Examples for different providers:
  // OpenAI Chat Completion (default, backward compatible):
  //   "memoryProvider": "openai-chat"
  //   "memoryModel": "gpt-4o-mini"
  //   "memoryApiUrl": "https://api.openai.com/v1"
  //   "memoryApiKey": "sk-..."
  
  // OpenAI Responses API (recommended, with session support):
  //   "memoryProvider": "openai-responses"
  //   "memoryModel": "gpt-4o"
  //   "memoryApiUrl": "https://api.openai.com/v1"
  //   "memoryApiKey": "sk-..."
  
  // Anthropic (with session support):
  //   "memoryProvider": "anthropic"
  //   "memoryModel": "claude-3-5-haiku-20241022"
  //   "memoryApiUrl": "https://api.anthropic.com/v1"
  //   "memoryApiKey": "sk-ant-..."
  
  // Groq (OpenAI-compatible, use openai-chat provider):
  //   "memoryProvider": "openai-chat"
  //   "memoryModel": "llama-3.3-70b-versatile"
  //   "memoryApiUrl": "https://api.groq.com/openai/v1"
  //   "memoryApiKey": "gsk_..."
  
  // Maximum iterations for multi-turn AI analysis (for openai-responses and anthropic)
  "autoCaptureMaxIterations": 5,
   
  // Timeout per iteration in milliseconds (30 seconds default)
  "autoCaptureIterationTimeout": 30000,
   
  // Days to keep AI session history before cleanup
  "aiSessionRetentionDays": 7,

  // Temperature for AI API requests (set to false to omit parameter for models that don't support it)
  // Some reasoning models (like o1, o3, gpt-5) don't support temperature parameter
  // Set to false and add "memoryTemperature": false in config when using such models
  "memoryTemperature": 0.3,

  // Language for auto-capture summaries (default: "auto" for auto-detection)
  // Options: "auto", "en", "id", "zh", "ja", "es", "fr", "de", "ru", "pt", "ar", "ko"
  // "autoCaptureLanguage": "auto",

  // ============================================
  // Toast Notifications
  // ============================================

  // Show toast when memory is auto-captured
  "showAutoCaptureToasts": true,

  // Show toast when user profile is updated
  "showUserProfileToasts": true,

  // Show toast for error messages
  "showErrorToasts": true,

  // ============================================
  // User Profile System
  // ============================================

  // Analyze user prompts every N prompts to build/update your user profile
  // When N uncaptured prompts accumulate, AI will analyze them to identify:
  // - User preferences (code style, communication style, tool preferences)
  // - User patterns (recurring topics, problem domains, technical interests)
  // - User workflows (development habits, sequences, learning style)
  // - Skill level (overall and per-domain assessment)
  "userProfileAnalysisInterval": 10,
  
  // Maximum number of preferences to keep in user profile (sorted by confidence)
  // Preferences are things like "prefers code without comments", "likes concise responses"
  "userProfileMaxPreferences": 20,
  
  // Maximum number of patterns to keep in user profile (sorted by frequency)
  // Patterns are recurring topics like "often asks about database optimization"
  "userProfileMaxPatterns": 15,
  
  // Maximum number of workflows to keep in user profile (sorted by frequency)
  // Workflows are sequences like "usually asks for tests after implementation"
  "userProfileMaxWorkflows": 10,
  
  // Days before preference confidence starts to decay (if not reinforced)
  // Preferences that aren't seen again will gradually lose confidence and be removed
  "userProfileConfidenceDecayDays": 30,
  
  // Number of profile versions to keep in changelog (for rollback/debugging)
  // Older versions are automatically cleaned up
  "userProfileChangelogRetentionCount": 5,
  
  // ============================================
  // Search Settings
  // ============================================
  
  // Minimum similarity score (0-1) for memory search results
  "similarityThreshold": 0.6,

  // Maximum number of memories to return in search results
  "maxMemories": 10,

  // ============================================
  // Advanced Settings
  // ============================================
  
  // Inject user profile into AI context (preferences, patterns, workflows)
  "injectProfile": true
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
  customSqlitePath: fileConfig.customSqlitePath
    ? expandPath(fileConfig.customSqlitePath)
    : undefined,
  userEmailOverride: fileConfig.userEmailOverride,
  userNameOverride: fileConfig.userNameOverride,
  embeddingModel: fileConfig.embeddingModel ?? DEFAULTS.embeddingModel,
  embeddingDimensions:
    fileConfig.embeddingDimensions ??
    getEmbeddingDimensions(fileConfig.embeddingModel ?? DEFAULTS.embeddingModel),
  embeddingApiUrl: fileConfig.embeddingApiUrl,
  embeddingApiKey: fileConfig.embeddingApiUrl
    ? resolveSecretValue(fileConfig.embeddingApiKey ?? process.env.OPENAI_API_KEY)
    : undefined,
  similarityThreshold: fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  maxProfileItems: fileConfig.maxProfileItems ?? DEFAULTS.maxProfileItems,
  injectProfile: fileConfig.injectProfile ?? DEFAULTS.injectProfile,
  containerTagPrefix: fileConfig.containerTagPrefix ?? DEFAULTS.containerTagPrefix,
  autoCaptureEnabled: fileConfig.autoCaptureEnabled ?? DEFAULTS.autoCaptureEnabled,
  autoCaptureMaxIterations:
    fileConfig.autoCaptureMaxIterations ?? DEFAULTS.autoCaptureMaxIterations,
  autoCaptureIterationTimeout:
    fileConfig.autoCaptureIterationTimeout ?? DEFAULTS.autoCaptureIterationTimeout,
  autoCaptureLanguage: fileConfig.autoCaptureLanguage,
  memoryProvider: (fileConfig.memoryProvider ?? "openai-chat") as
    | "openai-chat"
    | "openai-responses"
    | "anthropic",
  memoryModel: fileConfig.memoryModel,
  memoryApiUrl: fileConfig.memoryApiUrl,
  memoryApiKey: resolveSecretValue(fileConfig.memoryApiKey),
  memoryTemperature: fileConfig.memoryTemperature,
  aiSessionRetentionDays: fileConfig.aiSessionRetentionDays ?? DEFAULTS.aiSessionRetentionDays,
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
  userProfileAnalysisInterval:
    fileConfig.userProfileAnalysisInterval ?? DEFAULTS.userProfileAnalysisInterval,
  userProfileMaxPreferences:
    fileConfig.userProfileMaxPreferences ?? DEFAULTS.userProfileMaxPreferences,
  userProfileMaxPatterns: fileConfig.userProfileMaxPatterns ?? DEFAULTS.userProfileMaxPatterns,
  userProfileMaxWorkflows: fileConfig.userProfileMaxWorkflows ?? DEFAULTS.userProfileMaxWorkflows,
  userProfileConfidenceDecayDays:
    fileConfig.userProfileConfidenceDecayDays ?? DEFAULTS.userProfileConfidenceDecayDays,
  userProfileChangelogRetentionCount:
    fileConfig.userProfileChangelogRetentionCount ?? DEFAULTS.userProfileChangelogRetentionCount,
  showAutoCaptureToasts: fileConfig.showAutoCaptureToasts ?? DEFAULTS.showAutoCaptureToasts,
  showUserProfileToasts: fileConfig.showUserProfileToasts ?? DEFAULTS.showUserProfileToasts,
  showErrorToasts: fileConfig.showErrorToasts ?? DEFAULTS.showErrorToasts,
  compaction: {
    enabled: fileConfig.compaction?.enabled ?? DEFAULTS.compaction.enabled,
    memoryLimit: fileConfig.compaction?.memoryLimit ?? DEFAULTS.compaction.memoryLimit,
  },
  chatMessage: {
    enabled: fileConfig.chatMessage?.enabled ?? DEFAULTS.chatMessage.enabled,
    maxMemories: fileConfig.chatMessage?.maxMemories ?? DEFAULTS.chatMessage.maxMemories,
    excludeCurrentSession:
      fileConfig.chatMessage?.excludeCurrentSession ?? DEFAULTS.chatMessage.excludeCurrentSession,
    maxAgeDays: fileConfig.chatMessage?.maxAgeDays,
    injectOn: (fileConfig.chatMessage?.injectOn ?? DEFAULTS.chatMessage.injectOn) as
      | "first"
      | "always",
  },
};

export function isConfigured(): boolean {
  return true;
}
