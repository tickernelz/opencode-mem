/**
 * Shared endpoint/model defaults for OpenAI-compatible memory provider presets.
 *
 * Kept as a leaf module so `config.ts` can resolve key-only presets into
 * runtime `CONFIG.memoryModel` / `CONFIG.memoryApiUrl` without importing
 * provider classes (which pull in session managers that read `CONFIG`).
 */

export type MemoryProviderPresetId =
  | "orcarouter"
  | "atlas-cloud"
  | "cheaper-inference"
  | "api-route"
  | "runcrate"
  | "cloudgpu"
  | "standardcompute"
  | "uberllm";

export interface MemoryProviderPresetDefaults {
  apiUrl: string;
  model: string;
}

export const MEMORY_PROVIDER_PRESET_DEFAULTS: Record<
  MemoryProviderPresetId,
  MemoryProviderPresetDefaults
> = {
  orcarouter: {
    apiUrl: "https://api.orcarouter.ai/v1",
    model: "orcarouter/auto",
  },
  "atlas-cloud": {
    apiUrl: "https://api.atlascloud.ai/v1",
    model: "deepseek-ai/deepseek-v4-pro",
  },
  "cheaper-inference": {
    apiUrl: "https://api.cheaperinference.com/v1",
    model: "gpt-5.4-mini",
  },
  "api-route": {
    apiUrl: "https://global.api-route.com/v1",
    model: "gpt-6.1-sol",
  },
  runcrate: {
    apiUrl: "https://api.runcrate.ai/v1",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
  },
  cloudgpu: {
    apiUrl: "https://cloudgpu.app/v1",
    model: "deepseek-v4.1-flash",
  },
  standardcompute: {
    apiUrl: "https://api.stdcmpt.com/v1",
    model: "StandardCompute",
  },
  uberllm: {
    apiUrl: "https://api.uberllm.dev/v1",
    model: "deepseek/deepseek-v4-flash",
  },
};

export function isMemoryProviderPreset(
  provider: string | undefined
): provider is MemoryProviderPresetId {
  return (
    provider === "orcarouter" ||
    provider === "atlas-cloud" ||
    provider === "cheaper-inference" ||
    provider === "api-route" ||
    provider === "runcrate" ||
    provider === "cloudgpu" ||
    provider === "standardcompute" ||
    provider === "uberllm"
  );
}

export function resolveMemoryProviderPresetDefaults(
  provider: string | undefined
): MemoryProviderPresetDefaults | undefined {
  if (!isMemoryProviderPreset(provider)) return undefined;
  return MEMORY_PROVIDER_PRESET_DEFAULTS[provider];
}
