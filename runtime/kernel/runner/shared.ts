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
import { redactMemoryText } from "../memory/redaction.js";
import { readHomePrompt } from "../prompts/home-prompts.js";

export const DEFAULT_MAX_AGENT_DEPTH = 8;
export const LOCAL_HISTORY_RESERVE_TOKENS = 16_384;
export const MIN_LOCAL_HISTORY_TOKENS = 8_000;
export const DEFAULT_ORCHESTRATOR_PROMPT =
  "You are Stella's orchestrator. Coordinate specialized work and keep work non-blocking by default. " +
  "For visual user-facing output, use image_gen and keep plain text mainly for acknowledgments, brief confirmations, and short replies. " +
  "After using image_gen, keep any chat text to one short sentence unless the user explicitly asks for detailed text. " +
  "Delegate arbitrary desktop-app and browser work to the General agent, which uses Stella's persistent node_repl Computer Use and browser runtimes.";
export const DEFAULT_SUBAGENT_PROMPT =
  "You are a Stella sub-agent. Execute delegated work directly, provide concise progress, and run tools safely.";
export {
  LOCAL_CONTEXT_EVENT_TYPES,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
};

export const defaultPromptForAgentType = (
  agentType: string,
  stellaDataDir?: string,
): string => {
  if (isOrchestratorAgentType(agentType)) {
    return stellaDataDir
      ? readHomePrompt(
          stellaDataDir,
          "fallback-orchestrator",
          DEFAULT_ORCHESTRATOR_PROMPT,
        )
      : DEFAULT_ORCHESTRATOR_PROMPT;
  }
  return stellaDataDir
    ? readHomePrompt(
        stellaDataDir,
        "fallback-subagent",
        DEFAULT_SUBAGENT_PROMPT,
      )
    : DEFAULT_SUBAGENT_PROMPT;
};

export const readCoreMemory = (stellaDataDir: string): string | undefined => {
  const candidatePaths = [
    path.join(stellaDataDir, "core-memory.md"),
    path.join(stellaDataDir, "CORE_MEMORY.MD"),
  ];
  for (const filePath of candidatePaths) {
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        return redactMemoryText(content);
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

const readResidentMemoryDoc = (filePath: string): string | undefined => {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content ? redactMemoryText(content) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Dream's dynamic focus summary, read synchronously for resident injection.
 * Push-injected alongside core memory so the user's current active focus is
 * always in the Orchestrator's context (not only via the `Context` lookup).
 */
export const readMemorySummaryDoc = (
  stellaDataDir: string,
): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "memory_summary.md"),
  );

/**
 * The durable user-profile facts written by the `Remember` tool, read
 * synchronously for resident injection.
 */
export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(path.join(stellaDataDir, "memories", "profile.md"));

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
    event.type === "agent-canceled" &&
    (event.error === AGENT_SHUTDOWN_CANCEL_REASON ||
      event.error === AGENT_PAUSE_CANCEL_REASON)
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
    lines.push(
      "presentation: if the result is a report or substantial/dense information, present it as a canvas with the `html` tool — write the complete HTML document yourself from the result, and give the user only a short chat reply. For a quick answer or simple Q&A, reply directly in chat without `html`.",
    );
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
