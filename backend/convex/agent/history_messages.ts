// Re-export from @stella/shared — single source of truth for both
// the Convex backend and the Electron local runtime.
export {
  type ContextEvent,
  type HistoryMessage,
  type MicrocompactTrigger,
  type MicrocompactBoundaryPayload,
  type HistoryBuildOptions,
  type HistoryBuildResult,
  formatMessageTimestamp,
  eventsToHistoryMessages,
} from "@stella/shared";
