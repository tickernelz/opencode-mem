import type { ProviderConfig } from "./providers/base-provider.js";
import { isPlaceholderApiKey } from "./api-key-placeholder.js";

interface MemoryProviderRuntimeConfig {
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
  memoryTemperature?: number | false;
  memoryExtraParams?: Record<string, unknown>;
  autoCaptureMaxIterations?: number;
  autoCaptureIterationTimeout?: number;
}

interface ProviderConfigOverrides {
  maxIterations?: number;
  iterationTimeout?: number;
}

export function buildMemoryProviderConfig(
  config: MemoryProviderRuntimeConfig,
  overrides: ProviderConfigOverrides = {}
): ProviderConfig {
  const memoryModel = config.memoryModel;
  const memoryApiUrl = config.memoryApiUrl;
  const memoryApiKey = config.memoryApiKey;
  const issues: string[] = [];

  if (!memoryModel) issues.push("missing memoryModel");
  if (!memoryApiUrl) issues.push("missing memoryApiUrl");
  if (!memoryApiKey) issues.push("missing memoryApiKey");
  if (isPlaceholderApiKey(memoryApiKey)) issues.push("replace the placeholder memoryApiKey value");

  if (issues.length > 0) {
    throw new Error(`External API not configured for memory provider: ${issues.join("; ")}`);
  }

  return {
    model: memoryModel || "",
    apiUrl: memoryApiUrl || "",
    apiKey: memoryApiKey || "",
    memoryTemperature: config.memoryTemperature,
    extraParams: config.memoryExtraParams,
    maxIterations: overrides.maxIterations ?? config.autoCaptureMaxIterations,
    iterationTimeout: overrides.iterationTimeout ?? config.autoCaptureIterationTimeout,
  };
}
