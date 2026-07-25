/**
 * `WakeWhen` / `WakeCancel` — the escape hatch for waits that are not a
 * command exiting.
 *
 * The common case needs no tool: a long `exec_command` left running at turn
 * end is watched by the runtime and wakes the thread on exit (see
 * `runner/background-exit-wake.ts`). This covers the rest — a file
 * appearing, a remote job flipping to done, an endpoint going healthy —
 * where there is no local process whose exit means "ready".
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
      "Wait across turn boundaries on something that is NOT a local command finishing — a file appearing, a remote job reporting done, an endpoint going healthy. Registers a check with the runtime, which polls it from outside your session and resumes you, in this thread with your history, when it passes or times out. You do not need this to wait on a command you started: an exec_command session still running when your turn ends is already watched, and its exit wakes you automatically.",
    promptSnippet:
      "Wait on a non-process condition (file, remote status) across turns",
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
