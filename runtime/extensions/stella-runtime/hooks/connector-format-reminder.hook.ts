import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapInternalSystemReminder } from "../../../contracts/system-reminders.js";

/**
 * Connector-surface transition reminder (stella-runtime).
 *
 * The orchestrator handles both desktop and connector chats (Linq SMS,
 * Slack, Discord, Teams, Google Chat) in a single thread. The two
 * surfaces have very different rendering capabilities: the desktop
 * renders markdown and `html` artifacts inline, while connector chats
 * only show plain text.
 *
 * This hook prepends a hidden `<system_reminder>` on the single turn
 * where the routing surface changed (desktop → connector, connector →
 * desktop, or connector → different connector) so the orchestrator
 * adjusts its output format. Same-surface turns return nothing — the
 * reminder is fired exactly once per transition.
 *
 * The transition-detection work lives in `prepareOrchestratorRun`
 * (which already walks the recent local event stream); this hook just
 * checks for the pre-rendered text and injects it.
 */
export const createConnectorFormatReminderHook =
  (): HookDefinition<"before_user_message"> => ({
    event: "before_user_message",
    async handler(payload) {
      const text = payload.connectorTransitionReminderText?.trim();
      if (!text) return;
      return {
        prependMessages: [
          {
            text: wrapInternalSystemReminder(text),
            uiVisibility: "hidden",
            messageType: "message",
            customType: "runtime.connector_format_reminder",
          },
        ],
      };
    },
  });
