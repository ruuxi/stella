// Re-export from @stella/shared — single source of truth.
export {
  type ThreadSummaryInputMessage,
  type ThreadCompactionCut,
  formatThreadMessagesForCompaction,
  findThreadCompactionCutByTokens,
} from "@stella/shared";

// Legacy export kept for backward compat with threads.ts
export { findThreadCompactionCutByTokens as findRecentStartIndexByTokens } from "@stella/shared";
