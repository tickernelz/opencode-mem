import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

type CreateOpencodeClient = (config: { readonly baseUrl: string }) => OpencodeClient;

export type HostTransport = {
  readonly fetch?: typeof fetch;
  readonly headers?: RequestInit["headers"];
};

function getOpencodeSdkClientSpecifier(): string {
  return ["@opencode-ai/sdk", "/v2/client"].join("");
}

async function createSdkClient(
  baseUrl: string,
  transport?: HostTransport
): Promise<OpencodeClient> {
  const sdk = (await import(getOpencodeSdkClientSpecifier())) as {
    readonly createOpencodeClient: (
      config: CreateOpencodeClient extends (config: infer T) => OpencodeClient
        ? T & { readonly fetch?: typeof fetch; readonly headers?: RequestInit["headers"] }
        : never
    ) => OpencodeClient;
  };
  return sdk.createOpencodeClient({
    baseUrl,
    ...(transport?.fetch ? { fetch: transport.fetch } : {}),
    ...(transport?.headers ? { headers: transport.headers } : {}),
  });
}

export function createLazyV2Client(baseUrl: string, transport?: HostTransport): OpencodeClient {
  let sdkClientPromise: Promise<OpencodeClient> | undefined;
  const getSdkClient = (): Promise<OpencodeClient> => {
    sdkClientPromise ??= createSdkClient(baseUrl, transport);
    return sdkClientPromise;
  };

  return {
    session: {
      create: async (...args: Parameters<OpencodeClient["session"]["create"]>) => {
        const client = await getSdkClient();
        return client.session.create(...args);
      },
      prompt: async (...args: Parameters<OpencodeClient["session"]["prompt"]>) => {
        const client = await getSdkClient();
        return client.session.prompt(...args);
      },
      delete: async (...args: Parameters<OpencodeClient["session"]["delete"]>) => {
        const client = await getSdkClient();
        return client.session.delete(...args);
      },
      abort: async (...args: Parameters<OpencodeClient["session"]["abort"]>) => {
        const client = await getSdkClient();
        return client.session.abort(...args);
      },
    },
  } as OpencodeClient;
}
