/**
 * Public V1 plugin entry — implementation lives in hosts/opencode/.
 */
export {
  OpenCodeMemPlugin,
  INTERNAL_CAPTURE_SESSION_TITLE,
  isInternalCaptureSessionTitle,
  isStructuredSummaryPromptMessage,
  resolveSessionAgent,
  resolveSessionModel,
  applyStructuredOutputAgentConfig,
  applyStructuredOutputChatParams,
  configureOpencodeHostTransport,
} from "./hosts/opencode/plugin.js";
