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
import { readHomePrompt } from "../prompts/home-prompts.js";

export const DEFAULT_MAX_AGENT_DEPTH = 8;
export const LOCAL_HISTORY_RESERVE_TOKENS = 16_384;
export const MIN_LOCAL_HISTORY_TOKENS = 8_000;
export {
  LOCAL_CONTEXT_EVENT_TYPES,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
};

export const defaultPromptForAgentType = (
  agentType: string,
  stellaDataDir?: string,
): string =>
  stellaDataDir
    ? (readHomePrompt(
        stellaDataDir,
        isOrchestratorAgentType(agentType)
          ? "fallback-orchestrator"
          : "fallback-subagent",
      ) ?? "")
    : "";

// Resident-doc readers live in `kernel/memory/resident-docs.ts` (dependency-
// light so the compaction-boundary refresh in thread-runtime can share them
// without a module cycle); re-exported here for existing callers.
export {
  readCoreMemory,
  readMemoryIndexDoc,
  readMemorySummaryDoc,
  readUserProfileDoc,
} from "../memory/resident-docs.js";

const MAX_AGENT_EVENT_FIELD_CHARS = 30_000;

const truncateAgentEventField = (value: string): string =>
  value.length <= MAX_AGENT_EVENT_FIELD_CHARS
    ? value
    : `${value.slice(0, MAX_AGENT_EVENT_FIELD_CHARS)}\n[truncated ${value.length - MAX_AGENT_EVENT_FIELD_CHARS} chars]`;

export const buildAgentEventPrompt = (
  event: AgentLifecycleEvent,
  options?: { recipient?: "orchestrator" | "manager" },
): string | null => {
  if (
    event.type !== "agent-message" &&
    event.type !== "agent-completed" &&
    event.type !== "agent-failed" &&
    event.type !== "agent-canceled"
  ) {
    return null;
  }

  const lines: string[] = [];
  const isUserPausedManagedChild =
    event.type === "agent-canceled" &&
    event.error === AGENT_PAUSE_CANCEL_REASON &&
    options?.recipient === "manager";
  if (event.type === "agent-message") {
    lines.push("[Agent update]");
    if (event.description) {
      lines.push(`description: ${event.description}`);
    }
  } else if (event.type === "agent-completed") {
    lines.push("[Agent completed]");
    if (event.description) {
      lines.push(`description: ${event.description}`);
    }
  } else if (event.type === "agent-canceled") {
    lines.push(
      isUserPausedManagedChild ? "[Managed child paused]" : "[Task canceled]",
    );
  } else {
    lines.push("[Task failed]");
  }

  if (event.agentId) lines.push(`thread_id: ${event.agentId}`);
  if (event.agentType) lines.push(`agent_type: ${event.agentType}`);
  if (
    event.type !== "agent-message" &&
    event.type !== "agent-completed" &&
    event.description
  ) {
    lines.push(`description: ${event.description}`);
  }
  if (
    event.type === "agent-canceled" &&
    (event.error === AGENT_SHUTDOWN_CANCEL_REASON ||
      (event.error === AGENT_PAUSE_CANCEL_REASON &&
        options?.recipient !== "manager"))
  ) {
    return null;
  }
  if (event.type === "agent-completed" && event.result) {
    // Relay the sub-agent's full final report to the orchestrator without a
    // length cap. Truncating here silently drops the tail of the agent's
    // end-of-task report (the "what changed / outcome / blockers" section),
    // which makes the orchestrator relay false "done" summaries to the user.
    lines.push(`result: ${event.result}`);
  }
  if (event.type === "agent-message" && event.result) {
    lines.push(`message: ${event.result}`);
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
    if (options?.recipient === "manager") {
      lines.push(
        "routing: this is a managed child report. Continue the instructed process, including any next stage or fresh-review loop, and report upstream only according to your manager reporting rules.",
      );
    } else {
      lines.push(
        "presentation: if the result is a report or substantial/dense information, present it as a canvas with the `html` tool — write the complete HTML document yourself from the result, and give the user only a short chat reply. For a quick answer or simple Q&A, reply directly in chat without `html`.",
      );
    }
  }

  if (options?.recipient === "manager") {
    return [
      "<system_reminder>",
      isUserPausedManagedChild
        ? "A managed child was paused by the user. Reassess the process now: wait, respawn, or report according to the instructions. Do not remain parked waiting for that child."
        : "A managed child reached a terminal state. This report is for process coordination, not an automatic upstream update. Continue the instructed process and follow the manager reporting rules.",
      "</system_reminder>",
      "",
      ...lines,
    ].join("\n");
  }
  if (event.type === "agent-message") {
    return [
      "<system_reminder>",
      "A running manager sent a non-terminal update. Relay the update to the user without treating the manager or its work as completed.",
      "</system_reminder>",
      "",
      ...lines,
    ].join("\n");
  }
  return formatAgentTerminalStateSystemReminder(lines);
};

/**
 * Delivery mode for a chat message injected into a live orchestrator run.
 *
 * User messages on the NATIVE engine are `"steer"` so the agent sees them at
 * the next safe turn boundary and can respond mid-run. External CLI engines
 * (Claude Code, Codex) buffer steer and followUp identically and drain only
 * after the current turn completes, so user messages stay `"followUp"` there
 * to keep the semantics honest. Hidden runtime-internal injections (system
 * reminders, workspace-creation requests, etc.) always `"steer"`.
 */
export const resolveLiveChatMessageDelivery = (args: {
  role: string;
  engine: "native" | "external";
}): "steer" | "followUp" => {
  if (args.role !== "user") {
    return "steer";
  }
  return args.engine === "native" ? "steer" : "followUp";
};

/**
 * Mirror an injected live-run user message for abnormal-termination recovery.
 * If the run dies before the message is delivered, `flushPendingFollowUpReplies`
 * answers it in a fresh turn. Entries are keyed by `userMessageId` so
 * `prunePendingFollowUpReplies` can drop them once the message is actually
 * delivered to the model.
 */
export const recordPendingFollowUpReplyEntry = (
  replies: Map<string, import("./types.js").PendingFollowUpReply[]>,
  conversationId: string,
  entry: import("./types.js").PendingFollowUpReply,
): void => {
  const trimmed = entry.text.trim();
  if (!trimmed) {
    return;
  }
  const next = { ...entry, text: trimmed };
  const existing = replies.get(conversationId);
  if (existing) {
    existing.push(next);
  } else {
    replies.set(conversationId, [next]);
  }
};

/**
 * Drop recovery mirrors for a queued user message once it has been delivered
 * into the model context (the queued-user-message `message_start`). Without
 * this, a steered message answered mid-run would still be flushed — and
 * re-answered — if the run later ended abnormally. The remaining window (run
 * dies after delivery but before the answer completes) is a single turn, far
 * smaller than flushing every already-answered message.
 */
export const prunePendingFollowUpReplies = (
  replies: Map<string, import("./types.js").PendingFollowUpReply[]>,
  conversationId: string,
  userMessageId: string,
): void => {
  const existing = replies.get(conversationId);
  if (!existing) {
    return;
  }
  const remaining = existing.filter(
    (entry) => entry.userMessageId !== userMessageId,
  );
  if (remaining.length === 0) {
    replies.delete(conversationId);
  } else if (remaining.length !== existing.length) {
    replies.set(conversationId, remaining);
  }
};
