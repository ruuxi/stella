/**
 * Local agent runtime — barrel exports.
 */

export { handleChat, runSubagentTask, initRuntime } from "./runtime.js";
export type { ChatRequest, RuntimeConfig } from "./runtime.js";
export { resolveModelConfig, resolveFallbackConfig } from "./model_resolver.js";
export { buildSystemPrompt } from "./prompt_builder.js";
export { recallMemories, saveMemory, decayOldMemories } from "./memory.js";
export type { RecalledMemory } from "./memory.js";
export { generateSuggestions } from "./suggestions.js";
export {
  createTask,
  updateTaskStatus,
  cancelTask,
  getTaskById,
  listConversationTasks,
} from "./tasks_local.js";
