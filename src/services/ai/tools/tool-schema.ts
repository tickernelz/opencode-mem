export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export interface ResponsesAPITool {
  type: "custom";
  name: string;
  description: string;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export class ToolSchemaConverter {
  static toResponsesAPI(chatCompletionTool: ChatCompletionTool): ResponsesAPITool {
    return {
      type: "custom",
      name: chatCompletionTool.function.name,
      description: chatCompletionTool.function.description,
    };
  }

  static toAnthropic(chatCompletionTool: ChatCompletionTool): AnthropicTool {
    return {
      name: chatCompletionTool.function.name,
      description: chatCompletionTool.function.description,
      input_schema: chatCompletionTool.function.parameters,
    };
  }

  static fromChatCompletion(tool: ChatCompletionTool): {
    chatCompletion: ChatCompletionTool;
    responsesAPI: ResponsesAPITool;
    anthropic: AnthropicTool;
  } {
    return {
      chatCompletion: tool,
      responsesAPI: this.toResponsesAPI(tool),
      anthropic: this.toAnthropic(tool),
    };
  }
}
