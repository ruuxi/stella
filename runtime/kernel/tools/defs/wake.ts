/**
 * `WakeWhen` / `WakeCancel` — durable waits that survive the end of a turn.
 *
 * Available to every agent with a shell, because every agent with a shell
 * can start something that outlasts its turn. See `tools/wake.ts` for why
 * the runtime has to own the wait.
 */

import { handleWakeCancel, handleWakeWhen } from "../wake.js";
import type { ScheduleToolApi, ToolDefinition } from "../types.js";

export type WakeToolOptions = {
  scheduleApi?: ScheduleToolApi;
};

export const createWakeTools = (options: WakeToolOptions): ToolDefinition[] => [
  {
    name: "WakeWhen",
    description:
      "Wait on a long external event across turn boundaries. Registers a check with the runtime, which polls it and resumes you — in this thread, with your history — the moment it passes. Use this instead of leaving a background watcher running and ending your turn: processes you spawn keep running, but nothing they print can start a new turn, so you would never be resumed. Prefer finishing short waits inside the current turn; reach for WakeWhen when the wait is long enough that holding the turn open is wasteful.",
    promptSnippet:
      "Arm a runtime-owned wake for a long external event, then end your turn",
    parameters: {
      type: "object",
      properties: {
        when: {
          type: "string",
          description:
            "Shell command that exits 0 once the awaited thing has happened, and non-zero until then. Must be cheap and side-effect-free — it runs on every poll. Examples: `test -f /tmp/run/done`, `grep -q POD_JSON /tmp/monitor.log`, `curl -sf https://host/health`.",
        },
        then: {
          type: "string",
          description:
            "What you want handed back to yourself when the wake fires. Write it for a future you who has forgotten the details: what you were waiting on, and what to do next. The runtime prepends whether the condition was met or the wait timed out, plus the check's stdout.",
        },
        pollSeconds: {
          type: "number",
          description:
            "How often to run the check. Defaults to 30; clamped to 10..1800.",
        },
        timeoutMinutes: {
          type: "number",
          description:
            "Give up after this long and wake you anyway, flagged as expired, so the thread is never stuck. Defaults to 60; capped at 1440.",
        },
        cwd: {
          type: "string",
          description:
            "Absolute working directory for the check. Defaults to the turn's workspace root.",
        },
        name: {
          type: "string",
          description: "Short label for the wait. Defaults to the condition.",
        },
      },
      required: ["when", "then"],
    },
    execute: async (args, context) => {
      try {
        return await handleWakeWhen(options.scheduleApi, args, context);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "WakeCancel",
    description:
      "Cancel a wake armed by WakeWhen that is no longer needed — for example when you resolved the wait yourself inside the same turn.",
    parameters: {
      type: "object",
      properties: {
        wakeId: {
          type: "string",
          description: "Identifier returned by WakeWhen.",
        },
      },
      required: ["wakeId"],
    },
    execute: async (args) => {
      try {
        return await handleWakeCancel(options.scheduleApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
];
