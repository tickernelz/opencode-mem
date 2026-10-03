export type HostClientConfig = {
  readonly baseUrl: string | undefined;
  readonly fetch: typeof fetch | undefined;
  readonly headers?: RequestInit["headers"];
  readonly clientKeys: readonly string[];
  readonly sdkConfigCount: number;
};

export function getHostClientConfig(ctx: { readonly client: unknown }): HostClientConfig {
  const client = toRecord(ctx.client);
  if (!client) {
    return { baseUrl: undefined, fetch: undefined, clientKeys: [], sdkConfigCount: 0 };
  }

  const configs = sdkConfigs(client);
  const baseUrl = configs.find((config) => typeof config["baseUrl"] === "string")?.["baseUrl"];
  const customFetch = configs.find((config) => isFetch(config["fetch"]))?.["fetch"];
  const headers = configs.find((config) => isHeadersInit(config["headers"]))?.["headers"];

  return {
    baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
    fetch: isFetch(customFetch) ? customFetch : undefined,
    ...(isHeadersInit(headers) ? { headers } : {}),
    clientKeys: Object.keys(client),
    sdkConfigCount: configs.length,
  };
}

function sdkConfigs(client: Record<string, unknown>): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = [];
  const nestedClients = Object.values(client).flatMap((value): Record<string, unknown>[] => {
    const record = toRecord(value);
    return record ? [record] : [];
  });
  const candidates: Record<string, unknown>[] = [client, ...nestedClients];

  for (const candidate of candidates) {
    const sdkClient = toRecord(candidate["_client"]);
    const getConfig = sdkClient?.["getConfig"];
    if (!isConfigGetter(getConfig)) continue;

    const config = toRecord(getConfig.call(sdkClient));
    if (config) configs.push(config);
  }

  return configs;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function isConfigGetter(value: unknown): value is (this: unknown) => unknown {
  return typeof value === "function";
}

function isFetch(value: unknown): value is typeof fetch {
  return typeof value === "function";
}

function isHeadersInit(value: unknown): value is RequestInit["headers"] {
  return (
    value instanceof Headers ||
    Array.isArray(value) ||
    (typeof value === "object" && value !== null)
  );
}
