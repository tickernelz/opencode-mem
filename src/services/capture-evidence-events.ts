/** Only final evidence, never deltas, reasoning, attachments or arbitrary metadata. */
export function isCaptureEvidenceEvent(type: string): boolean {
  return [
    "message.updated",
    "message.part.updated",
    "session.inbox.delivered",
    "session.step.started",
    "session.text.ended",
    "session.tool.input.started",
    "session.tool.success",
    "session.tool.failed",
    "session.idle",
    "session.deleted",
  ].includes(type);
}
