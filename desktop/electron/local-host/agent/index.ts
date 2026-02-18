/**
 * Local agent runtime — barrel exports.
 */

export { handleChat, runSubagentTask, initRuntime } from "./runtime";
export type { ChatRequest, RuntimeConfig } from "./runtime";
export { resolveModelConfig, resolveFallbackConfig } from "./model_resolver";
export { buildSystemPrompt } from "./prompt_builder";
export { recallMemories, saveMemory, decayOldMemories } from "./memory";
export type { RecalledMemory } from "./memory";
export { generateSuggestions } from "./suggestions";
export {
  createTask,
  updateTaskStatus,
  cancelTask,
  getTaskById,
  listConversationTasks,
} from "./tasks_local";
