export async function loadOpencodeProvider(): Promise<OpencodeProviderModule> {
  const providerModule: OpencodeProviderModule = await import("./opencode-provider.js");
  return providerModule;
}

type OpencodeProviderModule = typeof import("./opencode-provider.js");
