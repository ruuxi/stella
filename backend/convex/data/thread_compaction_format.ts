// Re-export from local backend helpers.
export {
  type ThreadSummaryInputMessage,
  type ThreadCompactionCut,
  formatThreadMessagesForCompaction,
  findThreadCompactionCutByTokens,
} from "../lib/thread_compaction";

// Legacy export kept for backward compat with threads.ts
export { findThreadCompactionCutByTokens as findRecentStartIndexByTokens } from "../lib/thread_compaction";
