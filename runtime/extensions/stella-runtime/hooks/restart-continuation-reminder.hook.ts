import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "../../../kernel/agents/local-agent-manager.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { ExtensionServices } from "../../../kernel/extensions/services.js";
import { wrapSystemReminder } from "../../../kernel/message-timestamp.js";
import {
  RESTART_CONTINUATION_REMINDER_CUSTOM_TYPE,
  attachRestartReminderForConversation,
  buildRestartReminderText,
  describeCurrentThreadState,
  isRestartContinuationEnabled,
  resolveRestartReminderOutcome,
  type ThreadStateSentinels,
} from "../../../kernel/restart-continuation.js";

/**
 * Restart-continuation reminder (stella-runtime).
 *
 * When a restart/quit interrupted in-flight agent work, the FIRST user
 * message in an affected conversation after boot carries a hidden
 * `<system-reminder>`: a one-line restart notice plus the CURRENT state of
 * the threads that were running at shutdown (resolved live from the durable
 * thread rows — no before-state snapshotting).
 *
 * Delivery-safe one-shot: attaching only marks the reminder PENDING on the
 * carrying run; the paired `agent_end` hook consumes it when that run
 * completes successfully and clears the pending mark on failure/interruption
 * so the reminder re-attaches on the next user message.
 *
 * Complements the boot-time synthetic continuation turn per conversation:
 *  - the turn COMPLETED there → brief confirmation variant;
 *  - the turn failed, hung, was gated off, or the user messaged first → the
 *    reminder is the primary recovery path with full resume guidance.
 *
 * Clean-idle shutdowns never produce an interruption state, so these hooks
 * are cheap no-ops on normal boots. Automation/system turns run hidden
 * (`isUserTurn === false`) and never attach or consume the reminder —
 * including the synthetic continuation turn itself.
 */

const sentinels: ThreadStateSentinels = {
  pausedReasons: [AGENT_PAUSE_CANCEL_REASON],
  restartCancelReasons: [
    AGENT_ORPHANED_RESTART_CANCEL_REASON,
    AGENT_SHUTDOWN_CANCEL_REASON,
  ],
};

export const createRestartContinuationReminderHooks = (options: {
  /** `~/.stella` — where the interruption state file lives. */
  stellaDataDir: string;
  store: ExtensionServices["store"];
}): [HookDefinition<"before_user_message">, HookDefinition<"agent_end">] => {
  const attachHook: HookDefinition<"before_user_message"> = {
    event: "before_user_message",
    async handler(payload) {
      if (payload.agentType !== AGENT_IDS.ORCHESTRATOR) return;
      if (payload.isUserTurn === false) return;
      const conversationId = payload.conversationId;
      if (!conversationId) return;
      if (!isRestartContinuationEnabled(process.env)) return;

      let attached: ReturnType<typeof attachRestartReminderForConversation>;
      try {
        attached = attachRestartReminderForConversation(options.stellaDataDir, {
          conversationId,
          ...(payload.runId ? { runId: payload.runId } : {}),
        });
      } catch {
        return;
      }
      if (!attached) return;

      const threads = attached.threads.map((ref) => {
        const record = options.store.getAgentRecord?.(ref.threadId) ?? null;
        const current = describeCurrentThreadState(record, sentinels);
        return {
          threadId: ref.threadId,
          description: record?.description ?? "(unknown task)",
          agentType: record?.agentType ?? "unknown",
          stateLabel: current.label,
        };
      });

      const text = buildRestartReminderText({
        reason: attached.state.reason,
        shutdownAt: attached.state.shutdownAt,
        syntheticTurnCompleted: attached.turnCompleted,
        threads,
      });
      return {
        prependMessages: [
          {
            text: wrapSystemReminder(text),
            uiVisibility: "hidden" as const,
            messageType: "message" as const,
            customType: RESTART_CONTINUATION_REMINDER_CUSTOM_TYPE,
          },
        ],
      };
    },
  };

  const settleHook: HookDefinition<"agent_end"> = {
    event: "agent_end",
    async handler(payload) {
      if (payload.agentType !== AGENT_IDS.ORCHESTRATOR) return;
      const conversationId = payload.conversationId;
      if (!conversationId) return;
      if (!isRestartContinuationEnabled(process.env)) return;
      try {
        resolveRestartReminderOutcome(options.stellaDataDir, {
          conversationId,
          ...(payload.runId ? { runId: payload.runId } : {}),
          succeeded: payload.outcome === "success",
          ...(payload.isUserTurn !== undefined
            ? { isUserTurn: payload.isUserTurn }
            : {}),
        });
      } catch {
        // Best-effort: an unsettled pending reminder re-attaches next turn.
      }
    },
  };

  return [attachHook, settleHook];
};
