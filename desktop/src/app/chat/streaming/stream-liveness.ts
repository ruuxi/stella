const hasVisibleText = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

export const shouldVerifyStreamingLiveness = (args: {
  isStreaming: boolean;
  activeConversationId: string | null;
  pendingStartCount: number;
  queuedRunCount: number;
  liveTaskCount: number;
  runtimeStatusText: string | null;
  streamingText: string;
  reasoningText: string;
}): boolean => {
  if (!args.isStreaming || !args.activeConversationId) {
    return false;
  }
  if (args.pendingStartCount > 0 || args.queuedRunCount > 0) {
    return false;
  }
  if (args.liveTaskCount > 0) {
    return false;
  }
  if (
    hasVisibleText(args.runtimeStatusText) ||
    hasVisibleText(args.streamingText) ||
    hasVisibleText(args.reasoningText)
  ) {
    return false;
  }
  return true;
};
