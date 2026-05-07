import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapSystemReminder } from "../../../kernel/message-timestamp.js";

/**
 * Dynamic memory reminder (stella-runtime).
 *
 * Pairs with the orchestrator's reminder cadence: when
 * `shouldInjectDynamicReminder` is true and the runtime has a non-empty
 * `orchestratorReminderText`, this hook prepends it as a hidden
 * runtime-internal user message. Pre-migration this lived inline inside
 * `buildOrchestratorPromptMessages`.
 *
 * The cadence decision (which turns flip `shouldInjectDynamicReminder`)
 * is owned by the runtime today via
 * `runtime/kernel/agent-runtime/thread-memory.ts:updateOrchestratorReminderState`.
 * That logic could later move into the hook itself, but keeping the
 * cadence in the runtime preserves the existing SQLite-backed counter
 * semantics — this hook only consumes the decision.
 */
export const createDynamicMemoryReminderHook =
  (): HookDefinition<"before_user_message"> => ({
    event: "before_user_message",
    async handler(payload) {
      if (!payload.shouldInjectDynamicReminder) return;
      const text = payload.orchestratorReminderText?.trim();
      if (!text) return;
      return {
        prependMessages: [
          {
            text: wrapSystemReminder(text),
            uiVisibility: "hidden",
            messageType: "message",
            customType: "runtime.orchestrator_reminder",
          },
        ],
      };
    },
  });
