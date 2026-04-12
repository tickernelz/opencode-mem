import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CONFIG } from "../src/config.ts";

const originalConfig = {
  storagePath: CONFIG.storagePath,
  embeddingApiUrl: CONFIG.embeddingApiUrl,
  embeddingApiKey: CONFIG.embeddingApiKey,
  embeddingModel: CONFIG.embeddingModel,
};

const mockEnv = {
  allowLocalModels: false,
  allowRemoteModels: false,
  cacheDir: "",
};

let pipelineCalls = 0;
let pipelineImpl: () => Promise<any> = async () => async () => ({ data: new Float32Array([1]) });

mock.module("@xenova/transformers", () => ({
  env: mockEnv,
  pipeline: (..._args: unknown[]) => {
    pipelineCalls += 1;
    return pipelineImpl();
  },
}));

const { EmbeddingService } = await import("../src/services/embedding.ts");

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EmbeddingService warmup", () => {
  beforeEach(() => {
    pipelineCalls = 0;
    pipelineImpl = async () => async () => ({ data: new Float32Array([1]) });
    mockEnv.allowLocalModels = false;
    mockEnv.allowRemoteModels = false;
    mockEnv.cacheDir = "";
    CONFIG.storagePath = "/tmp/opencode-mem-test";
    CONFIG.embeddingApiUrl = "";
    CONFIG.embeddingApiKey = "";
    CONFIG.embeddingModel = "test-model";
  });

  afterEach(() => {
    CONFIG.storagePath = originalConfig.storagePath;
    CONFIG.embeddingApiUrl = originalConfig.embeddingApiUrl;
    CONFIG.embeddingApiKey = originalConfig.embeddingApiKey;
    CONFIG.embeddingModel = originalConfig.embeddingModel;
  });

  it("starts a fresh warmup generation after reset and ignores the stale result", async () => {
    let pipelineAttempt = 0;
    let firstWarmupSettled = false;
    let markFirstPipelineStarted!: () => void;
    let markSecondPipelineStarted!: () => void;
    let resolveFirstPipeline!: (value: any) => void;
    let resolveSecondPipeline!: (value: any) => void;
    const firstPipelineStarted = new Promise<void>((resolve) => {
      markFirstPipelineStarted = resolve;
    });
    const secondPipelineStarted = new Promise<void>((resolve) => {
      markSecondPipelineStarted = resolve;
    });

    pipelineImpl = () =>
      new Promise((resolve) => {
        pipelineAttempt += 1;

        if (pipelineAttempt === 1) {
          markFirstPipelineStarted();
          resolveFirstPipeline = resolve;
          return;
        }

        if (pipelineAttempt === 2) {
          markSecondPipelineStarted();
          resolveSecondPipeline = resolve;
          return;
        }

        resolve(async () => ({ data: new Float32Array([1]) }));
      });

    const service = new EmbeddingService();
    const firstWarmup = service.warmup();
    void firstWarmup.then(() => {
      firstWarmupSettled = true;
    });

    await firstPipelineStarted;
    service.resetWarmupState();

    const secondWarmup = service.warmup();
    await secondPipelineStarted;

    expect(pipelineCalls).toBe(2);

    resolveFirstPipeline(async () => ({ data: new Float32Array([1]) }));
    await flushMicrotasks();

    expect(firstWarmupSettled).toBe(false);
    expect(service.isWarmedUp).toBe(false);

    resolveSecondPipeline(async () => ({ data: new Float32Array([1]) }));
    await Promise.all([firstWarmup, secondWarmup]);

    expect(service.isWarmedUp).toBe(true);
    expect(pipelineCalls).toBe(2);
  });

  it("keeps waiting for the new generation when the stale initialization rejects", async () => {
    let pipelineAttempt = 0;
    let firstWarmupRejected = false;
    let markFirstPipelineStarted!: () => void;
    let markSecondPipelineStarted!: () => void;
    let rejectFirstPipeline!: (reason?: unknown) => void;
    let resolveSecondPipeline!: (value: any) => void;
    const firstPipelineStarted = new Promise<void>((resolve) => {
      markFirstPipelineStarted = resolve;
    });
    const secondPipelineStarted = new Promise<void>((resolve) => {
      markSecondPipelineStarted = resolve;
    });

    pipelineImpl = () =>
      new Promise((resolve, reject) => {
        pipelineAttempt += 1;

        if (pipelineAttempt === 1) {
          markFirstPipelineStarted();
          rejectFirstPipeline = reject;
          return;
        }

        if (pipelineAttempt === 2) {
          markSecondPipelineStarted();
          resolveSecondPipeline = resolve;
          return;
        }

        resolve(async () => ({ data: new Float32Array([1]) }));
      });

    const service = new EmbeddingService();
    const firstWarmup = service.warmup();
    void firstWarmup.catch(() => {
      firstWarmupRejected = true;
    });

    await firstPipelineStarted;
    service.resetWarmupState();

    const secondWarmup = service.warmup();
    await secondPipelineStarted;

    rejectFirstPipeline(new Error("stale boom"));
    await flushMicrotasks();

    expect(firstWarmupRejected).toBe(false);
    expect(service.isWarmedUp).toBe(false);

    resolveSecondPipeline(async () => ({ data: new Float32Array([1]) }));
    await Promise.all([firstWarmup, secondWarmup]);

    expect(firstWarmupRejected).toBe(false);
    expect(service.isWarmedUp).toBe(true);
    expect(pipelineCalls).toBe(2);
  });

  it("wakes waiters blocked on a stale hanging initialization after reset", async () => {
    let pipelineAttempt = 0;
    let firstWarmupResolved = false;
    let markFirstPipelineStarted!: () => void;
    let markSecondPipelineStarted!: () => void;
    let resolveSecondPipeline!: (value: any) => void;
    const firstPipelineStarted = new Promise<void>((resolve) => {
      markFirstPipelineStarted = resolve;
    });
    const secondPipelineStarted = new Promise<void>((resolve) => {
      markSecondPipelineStarted = resolve;
    });

    pipelineImpl = () => {
      pipelineAttempt += 1;

      if (pipelineAttempt === 1) {
        markFirstPipelineStarted();
        return new Promise(() => {});
      }

      if (pipelineAttempt === 2) {
        return new Promise((resolve) => {
          markSecondPipelineStarted();
          resolveSecondPipeline = resolve;
        });
      }

      return Promise.resolve(async () => ({ data: new Float32Array([1]) }));
    };

    const service = new EmbeddingService();
    const firstWarmup = service.warmup();
    void firstWarmup.then(() => {
      firstWarmupResolved = true;
    });

    await firstPipelineStarted;
    service.resetWarmupState();

    const secondWarmup = service.warmup();
    await secondPipelineStarted;

    expect(firstWarmupResolved).toBe(false);
    expect(service.isWarmedUp).toBe(false);

    resolveSecondPipeline(async () => ({ data: new Float32Array([1]) }));
    await Promise.all([firstWarmup, secondWarmup]);

    expect(firstWarmupResolved).toBe(true);
    expect(service.isWarmedUp).toBe(true);
    expect(pipelineCalls).toBe(2);
  });

  it("allows a new warmup attempt after the previous initialization fails", async () => {
    const service = new EmbeddingService();

    pipelineImpl = async () => {
      throw new Error("boom");
    };

    let thrown: unknown;
    try {
      await service.warmup();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("boom");
    expect(service.isWarmedUp).toBe(false);

    pipelineImpl = async () => async () => ({ data: new Float32Array([1]) });

    await service.warmup();
    expect(service.isWarmedUp).toBe(true);
    expect(pipelineCalls).toBe(2);
  });
});
