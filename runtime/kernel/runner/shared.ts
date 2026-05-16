import fs from "fs";
import path from "path";
import {
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
  type AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import { LOCAL_CONTEXT_EVENT_TYPES } from "../local-history.js";
import {
  readConfiguredConvexUrl as sanitizeConvexDeploymentUrl,
  readConfiguredStellaBaseUrl as sanitizeStellaBase,
} from "../convex-urls.js";
import { isOrchestratorAgentType } from "../../contracts/agent-runtime.js";
import { formatAgentTerminalStateSystemReminder } from "../../contracts/system-reminders.js";

export const DEFAULT_MAX_AGENT_DEPTH = 8;
export const LOCAL_HISTORY_RESERVE_TOKENS = 16_384;
export const MIN_LOCAL_HISTORY_TOKENS = 8_000;
export const DEFAULT_ORCHESTRATOR_PROMPT =
  "You are Stella's orchestrator. Coordinate specialized work and keep work non-blocking by default. " +
  "For visual user-facing output, use image_gen and keep plain text mainly for acknowledgments, brief confirmations, and short replies. " +
  "After using image_gen, keep any chat text to one short sentence unless the user explicitly asks for detailed text. " +
  'Use `stella-computer list-apps`, `stella-computer snapshot`, element-based `stella-computer click`, `fill "text"`, `secondary-action`, `scroll`, and coordinate/element drag commands (`drag`, `drag-screenshot`, `drag-element`) for arbitrary desktop apps via stella-computer automation.';
export const DEFAULT_SUBAGENT_PROMPT =
  "You are a Stella sub-agent. Execute delegated work directly, provide concise progress, and run tools safely.";
export {
  LOCAL_CONTEXT_EVENT_TYPES,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
};

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

const MAX_AGENT_EVENT_FIELD_CHARS = 30_000;

const truncateAgentEventField = (value: string): string =>
  value.length <= MAX_AGENT_EVENT_FIELD_CHARS
    ? value
    : `${value.slice(0, MAX_AGENT_EVENT_FIELD_CHARS)}\n[truncated ${value.length - MAX_AGENT_EVENT_FIELD_CHARS} chars]`;

export const buildAgentEventPrompt = (
  event: AgentLifecycleEvent,
): string | null => {
  if (
    event.type !== "agent-completed" &&
    event.type !== "agent-failed" &&
    event.type !== "agent-canceled"
  ) {
    return null;
  }

  const lines: string[] = [];
  if (event.type === "agent-completed") {
    lines.push("[Agent completed]");
    if (event.description) {
      lines.push(`description: ${event.description}`);
    }
  } else if (event.type === "agent-canceled") {
    lines.push("[Task canceled]");
  } else {
    lines.push("[Task failed]");
  }

  if (event.agentId) lines.push(`thread_id: ${event.agentId}`);
  if (event.agentType) lines.push(`agent_type: ${event.agentType}`);
  if (event.type !== "agent-completed" && event.description) {
    lines.push(`description: ${event.description}`);
  }
  if (
    event.type === "agent-canceled"
    && (event.error === AGENT_SHUTDOWN_CANCEL_REASON
      || event.error === AGENT_PAUSE_CANCEL_REASON)
  ) {
    return null;
  }
  if (event.type === "agent-completed" && event.result) {
    lines.push(`result: ${truncateAgentEventField(event.result)}`);
  }
  if (event.type === "agent-completed" && event.fileChanges?.length) {
    lines.push("explicit file changes:");
    for (const change of event.fileChanges.slice(0, 20)) {
      const destination =
        change.kind.type === "update" && change.kind.move_path
          ? ` -> ${change.kind.move_path}`
          : "";
      lines.push(`- ${change.kind.type}: ${change.path}${destination}`);
    }
    if (event.fileChanges.length > 20) {
      lines.push(`- ... ${event.fileChanges.length - 20} more`);
    }
  }
  if (event.type === "agent-completed" && event.producedFiles?.length) {
    lines.push("produced files:");
    for (const file of event.producedFiles.slice(0, 20)) {
      const destination =
        file.kind.type === "update" && file.kind.move_path
          ? ` -> ${file.kind.move_path}`
          : "";
      lines.push(`- ${file.kind.type}: ${file.path}${destination}`);
    }
    if (event.producedFiles.length > 20) {
      lines.push(`- ... ${event.producedFiles.length - 20} more`);
    }
  }
  if (
    (event.type === "agent-failed" || event.type === "agent-canceled") &&
    event.error
  ) {
    lines.push(`error: ${truncateAgentEventField(event.error)}`);
  }
  if (event.type === "agent-completed") {
    lines.push(
      "agent_state: paused; this agent is not currently working. Use send_input to resume the same thread if follow-up work is needed.",
    );
  }

  return formatAgentTerminalStateSystemReminder(lines);
};
