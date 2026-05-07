import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapSystemReminder } from "../../../kernel/message-timestamp.js";

/**
 * Stale-user reminder (stella-runtime).
 *
 * Forwards the orchestrator's "user has been idle for a while; here's a
 * reminder of where the conversation left off" text into the prompt as
 * a hidden runtime-internal user message. Pre-migration this was an
 * inline branch inside `buildOrchestratorPromptMessages`; converting
 * to a `before_user_message` hook keeps the kernel agnostic about
 * Stella-specific conversational state.
 *
 * The runtime computes the actual reminder text in
 * `prepareOrchestratorRun` and forwards it through the
 * `LocalAgentContext` → hook payload. The hook just decides "should
 * this turn carry the reminder?" (it does whenever non-empty text is
 * present).
 */
export const createStaleUserReminderHook =
  (): HookDefinition<"before_user_message"> => ({
    event: "before_user_message",
    async handler(payload) {
      const text = payload.staleUserReminderText?.trim();
      if (!text) return;
      return {
        prependMessages: [
          {
            text: wrapSystemReminder(text),
            uiVisibility: "hidden",
            messageType: "message",
            customType: "runtime.stale_user_reminder",
          },
        ],
      };
    },
  });
