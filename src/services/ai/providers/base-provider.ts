export interface ToolCallResult {
  success: boolean;
  data?: any;
  error?: string;
  iterations?: number;
}

export interface ProviderConfig {
  model: string;
  apiUrl: string;
  apiKey?: string;
  maxIterations?: number;
  iterationTimeout?: number;
  maxTokens?: number;
  memoryTemperature?: number | false;
  extraParams?: Record<string, unknown>;
}

const PROTECTED_KEYS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "temperature",
  "input",
  "instructions",
  "conversation",
  "stream",
]);

export function applySafeExtraParams(
  requestBody: Record<string, any>,
  extraParams: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(extraParams)) {
    if (!PROTECTED_KEYS.has(key)) {
      requestBody[key] = value;
    }
  }
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
