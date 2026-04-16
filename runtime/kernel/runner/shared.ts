import fs from "fs";
import path from "path";
import {
  TASK_SHUTDOWN_CANCEL_REASON,
  type TaskLifecycleEvent,
} from "../tasks/local-task-manager.js";
import { LOCAL_CONTEXT_EVENT_TYPES } from "../local-history.js";
import {
  readConfiguredConvexUrl as sanitizeConvexDeploymentUrl,
  readConfiguredStellaBaseUrl as sanitizeStellaBase,
} from "../convex-urls.js";
import { isOrchestratorAgentType } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import type { SelfModHmrState } from "../../contracts/index.js";

export const DEFAULT_MAX_TASK_DEPTH = 8;
export const LOCAL_HISTORY_RESERVE_TOKENS = 16_384;
export const MIN_LOCAL_HISTORY_TOKENS = 8_000;
export const DEFAULT_ORCHESTRATOR_PROMPT =
  "You are Stella's orchestrator. Coordinate specialized work and keep work non-blocking by default. " +
  "For user-facing output, prefer Display for most substantive, structured, or multi-item responses and keep plain text mainly for acknowledgments, brief confirmations, and short replies. " +
  "After using Display, keep any chat text to one short sentence unless the user explicitly asks for detailed text. " +
  'You can interact with Stella\'s desktop UI via `stella-ui snapshot`, `stella-ui click @ref`, `stella-ui fill @ref "text"` in Bash.';
export const DEFAULT_SUBAGENT_PROMPT =
  "You are a Stella sub-agent. Execute delegated work directly, provide concise progress, and run tools safely. " +
  "When creating or modifying UI components, add data-stella-label, data-stella-state, and data-stella-action attributes.";
export {
  LOCAL_CONTEXT_EVENT_TYPES,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
};
export const QUEUED_TURN_INTERRUPT_ERROR =
  "Interrupted by queued orchestrator turn";

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const defaultPromptForAgentType = (agentType: string): string => {
  if (isOrchestratorAgentType(agentType)) return DEFAULT_ORCHESTRATOR_PROMPT;
  return DEFAULT_SUBAGENT_PROMPT;
};

export const readCoreMemory = (stellaHome: string): string | undefined => {
  const candidatePaths = [
    path.join(stellaHome, "state", "core-memory.md"),
    path.join(stellaHome, "state", "CORE_MEMORY.MD"),
  ];
  for (const filePath of candidatePaths) {
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        return content;
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

export const buildTaskEventPrompt = (
  event: TaskLifecycleEvent,
): string | null => {
  if (
    event.type !== "task-completed" &&
    event.type !== "task-failed" &&
    event.type !== "task-canceled"
  ) {
    return null;
  }

  const lines =
    event.type === "task-completed"
      ? ["[Task completed]"]
      : event.type === "task-canceled"
        ? ["[Task canceled]"]
        : ["[Task failed]"];

  if (event.taskId) lines.push(`thread_id: ${event.taskId}`);
  if (event.agentType) lines.push(`agent_type: ${event.agentType}`);
  if (event.description) lines.push(`description: ${event.description}`);
  if (
    event.type === "task-canceled"
    && event.error === TASK_SHUTDOWN_CANCEL_REASON
  ) {
    return null;
  }
  if (event.type === "task-completed" && event.result) {
    lines.push(`result: ${event.result}`);
  }
  if (
    (event.type === "task-failed" || event.type === "task-canceled") &&
    event.error
  ) {
    lines.push(`error: ${event.error}`);
  }

  return [
    "<system_reminder>",
    "This task lifecycle update is hidden from the user.",
    "Do not narrate background coordination or ask follow-up questions in chat text.",
    "If more background work is needed, use task tools quietly without narrating the coordination.",
    "Only send a normal assistant reply when you are ready to say something to the user.",
    "</system_reminder>",
    "",
    ...lines,
  ].join("\n");
};

export const createSelfModHmrState = (
  phase: SelfModHmrState["phase"],
  paused: boolean,
  requiresFullReload = false,
): SelfModHmrState => ({
  phase,
  paused,
  requiresFullReload,
});
