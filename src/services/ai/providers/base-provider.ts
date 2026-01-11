export interface ToolCallResult {
  success: boolean;
  data?: any;
  error?: string;
  iterations?: number;
}

export interface ProviderConfig {
  model: string;
  apiUrl: string;
  apiKey: string;
  maxIterations: number;
  iterationTimeout: number;
}

export abstract class BaseAIProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract executeToolCall(
    systemPrompt: string,
    userPrompt: string,
    toolSchema: any,
    sessionId: string
  ): Promise<ToolCallResult>;

  abstract getProviderName(): string;

  abstract supportsSession(): boolean;
}
