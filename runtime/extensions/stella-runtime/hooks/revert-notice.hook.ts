import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { RuntimePromptMessage } from "../../../protocol/index.js";
import { wrapSystemReminder } from "../../../kernel/message-timestamp.js";
import type { ExtensionServices } from "../../../kernel/extensions/services.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { SelfModRevertRecord } from "../../../kernel/storage/self-mod-reverts.js";

/**
 * Self-mod revert notice (stella-runtime).
 *
 * Companion to the inline "Undo changes" button rendered on every
 * self-mod assistant turn (`desktop/src/app/chat/SelfModUndoButton.tsx`).
 * When the user clicks undo, the worker's
 * `INTERNAL_WORKER_SELF_MOD_REVERT` handler runs `revertGitFeature`
 * and records a row in `self_mod_reverts` keyed by:
 *   - `conversationId` (from the commit's `Stella-Conversation` trailer)
 *   - `originThreadKey`  (from the commit's `Stella-Thread` trailer)
 *
 * This hook fires on `before_user_message` for both orchestrator and
 * subagent prompt builds. Per-agent-type consumption:
 *
 *   - **Orchestrator turn** (`agentType === orchestrator`): drains the
 *     orchestrator slot for any pending revert on this conversation.
 *     The orchestrator sees the notice on the user's next visible turn
 *     so it can adjust strategy / craft a follow-up `send_input`
 *     informed by the undo.
 *   - **Resumed subagent turn**: drains the origin-thread slot when
 *     `payload.threadKey` matches the reverted commit's `Stella-Thread`
 *     trailer. This is the "user undid the change you just made"
 *     reminder for the specific agent the orchestrator resumed via
 *     `send_input`.
 *
 * Gated on `isUserTurn === true`: hidden synthetic turns (commit-subject
 * namer, memory-review subagent, etc.) must not consume the reminder
 * before the user's real next turn ever sees it.
 *
 * The reminder is intentionally bare — just informs that the user
 * undid the change, without prescribing acknowledgement behavior.
 */

const MAX_FILES_INLINE = 6;

const formatFilesSummary = (files: string[]): string => {
  const trimmed = files.filter((file) => file.trim().length > 0);
  if (trimmed.length === 0) return "";
  if (trimmed.length <= MAX_FILES_INLINE) {
    return trimmed.join(", ");
  }
  const head = trimmed.slice(0, MAX_FILES_INLINE).join(", ");
  return `${head} (+${trimmed.length - MAX_FILES_INLINE} more)`;
};

const buildReminderText = (pending: SelfModRevertRecord[]): string => {
  if (pending.length === 1) {
    const filesSummary = formatFilesSummary(pending[0]!.files);
    return filesSummary
      ? `The user undid your last change (files: ${filesSummary}).`
      : "The user undid your last change.";
  }
  return `The user undid your last ${pending.length} changes.`;
};

const createReminderMessage = (text: string): RuntimePromptMessage => ({
  text: wrapSystemReminder(text),
  uiVisibility: "hidden",
  messageType: "message",
  customType: "runtime.self_mod_revert_notice",
});

export const createRevertNoticeHook = (
  services: Pick<ExtensionServices, "store">,
): HookDefinition<"before_user_message"> => ({
  event: "before_user_message",
  async handler(payload) {
    // Synthetic hidden turns must not consume the notice — same gate as
    // chronicle-injection.hook.ts.
    if (payload.isUserTurn !== true) return;

    const isOrchestrator = payload.agentType === AGENT_IDS.ORCHESTRATOR;

    let pending: SelfModRevertRecord[] = [];
    try {
      if (isOrchestrator) {
        if (!payload.conversationId) return;
        pending = services.store.listPendingOrchestratorReverts(
          payload.conversationId,
        );
      } else {
        // For subagents, only the SPECIFIC originating thread should
        // see the notice — match against `payload.threadKey`. Other
        // subagent types (fashion, install-update, fresh general
        // spawns, …) skip silently because their threadKey won't match
        // any pending revert's `origin_thread_key`.
        if (!payload.threadKey) return;
        pending = services.store.listPendingOriginThreadReverts(
          payload.threadKey,
        );
      }
    } catch {
      // Ledger read failure must not block the user's turn.
      return;
    }
    if (pending.length === 0) return;

    try {
      const revertIds = pending.map((row) => row.revertId);
      if (isOrchestrator) {
        services.store.markSelfModRevertsOrchestratorConsumed(revertIds);
      } else {
        services.store.markSelfModRevertsOriginThreadConsumed(revertIds);
      }
    } catch {
      // Consume-write failure means the same revert may re-inject next
      // turn — preferable to dropping the notice that just fired.
    }

    return {
      prependMessages: [createReminderMessage(buildReminderText(pending))],
    };
  },
});
