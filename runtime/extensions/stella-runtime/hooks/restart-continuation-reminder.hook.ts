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
  buildRestartReminderText,
  consumeRestartReminderForConversation,
  describeCurrentThreadState,
  isRestartContinuationEnabled,
  type ThreadStateSentinels,
} from "../../../kernel/restart-continuation.js";

/**
 * Restart-continuation reminder (stella-runtime).
 *
 * When a restart/quit interrupted in-flight agent work, the FIRST user
 * message in an affected conversation after boot carries a hidden
 * `<system-reminder>`: a one-line restart notice plus the CURRENT state of
 * the threads that were running at shutdown (resolved live from the durable
 * thread rows — no before-state snapshotting). One-shot per interruption per
 * conversation; consumed on attach.
 *
 * Complements the boot-time synthetic continuation turn:
 *  - turn already fired → the reminder still attaches once, marked as
 *    confirmation so the orchestrator doesn't duplicate resumption;
 *  - turn didn't fire (turn gated off, or the user messaged first) → the
 *    reminder is the primary recovery path and carries resume guidance.
 *
 * Clean-idle shutdowns never produce an interruption state, so this hook is
 * a cheap no-op on normal boots. Automation/system turns run hidden
 * (`isUserTurn === false`) and never consume the reminder — including the
 * synthetic continuation turn itself.
 */
export const createRestartContinuationReminderHook = (options: {
  /** `~/.stella` — where the interruption state file lives. */
  stellaDataDir: string;
  store: ExtensionServices["store"];
}): HookDefinition<"before_user_message"> => ({
  event: "before_user_message",
  async handler(payload) {
    if (payload.agentType !== AGENT_IDS.ORCHESTRATOR) return;
    if (payload.isUserTurn === false) return;
    const conversationId = payload.conversationId;
    if (!conversationId) return;
    if (!isRestartContinuationEnabled(process.env)) return;

    let consumed: ReturnType<typeof consumeRestartReminderForConversation>;
    try {
      consumed = consumeRestartReminderForConversation(
        options.stellaDataDir,
        conversationId,
      );
    } catch {
      return;
    }
    if (!consumed) return;

    const sentinels: ThreadStateSentinels = {
      pausedReasons: [AGENT_PAUSE_CANCEL_REASON],
      restartCancelReasons: [
        AGENT_ORPHANED_RESTART_CANCEL_REASON,
        AGENT_SHUTDOWN_CANCEL_REASON,
      ],
    };
    const threads = consumed.threads.map((ref) => {
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
      reason: consumed.state.reason,
      shutdownAt: consumed.state.shutdownAt,
      syntheticTurnFired: Boolean(consumed.state.syntheticTurnFiredAt),
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
});
