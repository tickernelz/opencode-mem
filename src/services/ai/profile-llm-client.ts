import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { CONFIG } from "../../config.js";

let _cachedClient: OpencodeClient | null = null;
let _cachedProvider: string | null = null;
let _cachedModel: string | null = null;

export async function getOpenCodeClient(): Promise<OpencodeClient> {
  const provider = CONFIG.opencodeProvider!;
  const model = CONFIG.opencodeModel!;

  if (!provider || !model) {
    throw new Error("opencode-mem: opencodeProvider and opencodeModel must be configured");
  }

  if (_cachedClient && _cachedProvider === provider && _cachedModel === model) {
    return _cachedClient;
  }

  const { isProviderConnected, getV2Client } = await import("./opencode-provider.js");

  if (!isProviderConnected(provider)) {
    throw new Error(
      `opencode provider '${provider}' is not connected. Check your opencode provider configuration.`
    );
  }

  const client = getV2Client();
  if (!client) {
    throw new Error("opencode-mem: v2 client not initialized");
  }

  _cachedClient = client;
  _cachedProvider = provider;
  _cachedModel = model;
  return client;
}
