import type { ProviderConfig } from "./providers/base-provider.js";

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
  if (!config.memoryModel || !config.memoryApiUrl) {
    throw new Error("External API not configured for memory provider");
  }

  return {
    model: config.memoryModel,
    apiUrl: config.memoryApiUrl,
    apiKey: config.memoryApiKey,
    memoryTemperature: config.memoryTemperature,
    extraParams: config.memoryExtraParams,
    maxIterations: overrides.maxIterations ?? config.autoCaptureMaxIterations,
    iterationTimeout: overrides.iterationTimeout ?? config.autoCaptureIterationTimeout,
  };
}
