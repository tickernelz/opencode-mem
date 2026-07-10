import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

type CreateOpencodeClient = (config: { readonly baseUrl: string }) => OpencodeClient;

function getOpencodeSdkClientSpecifier(): string {
  return ["@opencode-ai/sdk", "/v2/client"].join("");
}

async function createSdkClient(baseUrl: string): Promise<OpencodeClient> {
  const sdk = (await import(getOpencodeSdkClientSpecifier())) as {
    readonly createOpencodeClient: CreateOpencodeClient;
  };
  return sdk.createOpencodeClient({ baseUrl });
}

export function createLazyV2Client(baseUrl: string): OpencodeClient {
  let sdkClientPromise: Promise<OpencodeClient> | undefined;
  const getSdkClient = (): Promise<OpencodeClient> => {
    sdkClientPromise ??= createSdkClient(baseUrl);
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
    },
  } as OpencodeClient;
}
