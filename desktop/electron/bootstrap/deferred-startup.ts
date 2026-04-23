import { getSelectedText, initSelectedTextProcess } from "../selected-text.js";
import { ChronicleController } from "../services/chronicle-controller.js";
import { hasMacPermission } from "../utils/macos-permissions.js";
import { type BootstrapContext } from "./context.js";

// Codex's Chronicle daemon refreshes the rolling 10-min summary once per
// minute and the rolling 6-hour summary once per hour. We mirror those
// cadences from the Electron host (see chronicle-summarizer.ts).
const CHRONICLE_10M_TICK_INTERVAL_MS = 60_000;
const CHRONICLE_6H_TICK_INTERVAL_MS = 60 * 60_000;
// Wait this long after startup before the first 10m tick fires, to avoid
// summarizing pre-startup or near-empty capture windows. Codex behaves
// similarly: Phase-2 consolidation runs at app startup once Phase 1 catches
// up, not on a wall-clock interval.
const CHRONICLE_FIRST_TICK_DELAY_MS = 30_000;

type DeferredStartupTask = {
  delayMs?: number;
  label: string;
  run: () => Promise<void> | void;
};

const runDeferredStartupTask = async (
  context: BootstrapContext,
  task: DeferredStartupTask,
) => {
  if (task.delayMs) {
    const completed = await context.state.processRuntime.wait(task.delayMs);
    if (!completed) {
      return false;
    }
  }

  if (context.state.isQuitting || context.state.processRuntime.isShuttingDown()) {
    return false;
  }

  await task.run();
  return true;
};

const createDeferredStartupTasks = (
  context: BootstrapContext,
): DeferredStartupTask[] => {
  const { config, services, state } = context;
  const isChronicleEnabled = async (): Promise<boolean> => {
    if (!state.chronicleController) {
      return false;
    }
    try {
      return await state.chronicleController.isEnabled();
    } catch {
      return false;
    }
  };

  return [
    {
      label: "overlay-window",
      run: () => {
        state.overlayController?.create();
      },
    },
    {
      label: "selected-text",
      delayMs: config.startupStageDelayMs,
      run: () => {
        initSelectedTextProcess();
        if (process.platform === "win32") {
          context.state.processRuntime.setManagedTimeout(() => {
            void getSelectedText();
          }, 250);
        }
      },
    },
    {
      label: "global-input-hooks",
      delayMs: config.startupStageDelayMs,
      run: () => {
        if (process.platform === "darwin" && !hasMacPermission("accessibility", false)) {
          return;
        }
        services.radialGestureService.start();
        services.selectionWatcherService.start();
      },
    },
    {
      label: "chronicle-daemon",
      delayMs: config.startupStageDelayMs,
      run: async () => {
        const stellaHome = state.stellaRoot;
        if (!stellaHome) return;
        if (!state.chronicleController) {
          state.chronicleController = new ChronicleController(stellaHome);
        }
        const result = await state.chronicleController.start();
        if (!result.started) {
          console.log(`[chronicle] not started: ${result.reason ?? "unknown"}`);
        }
      },
    },
    {
      // One-shot catch-up sweep: anything left in thread_summaries or
      // memories_extensions/ from the prior session should get folded
      // immediately on startup, not 60 seconds later. Mirrors Codex's
      // startup-driven Phase 2 run.
      label: "dream-startup-sweep",
      delayMs: config.startupStageDelayMs,
      run: () => {
        const runner = context.lifecycle.getRunner();
        if (!runner) {
          return;
        }
        void runner.triggerDreamNow("startup_catchup").catch((error) => {
          console.debug(
            "[dream] startup sweep failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
      },
    },
    {
      // Chronicle 10-minute rolling summary: distill the last ~10 min of OCR
      // deltas every minute, then poke Dream so the new file is folded into
      // MEMORY.md right away rather than waiting for the next subagent
      // finalize or the 15-min idle gate.
      label: "chronicle-10m-tick",
      delayMs: CHRONICLE_FIRST_TICK_DELAY_MS,
      run: () => {
        const runOnce = async () => {
          if (!(await isChronicleEnabled())) return;
          const runner = context.lifecycle.getRunner();
          if (!runner) return;
          let result;
          try {
            result = await runner.runChronicleSummaryTick("10m");
          } catch (error) {
            console.debug(
              "[chronicle] 10m tick failed:",
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          if (result.wrote) {
            void runner.triggerDreamNow("chronicle_summary").catch(() => {});
          }
        };
        void runOnce();
        context.state.processRuntime.setManagedInterval(() => {
          void runOnce();
        }, CHRONICLE_10M_TICK_INTERVAL_MS);
      },
    },
    {
      // Chronicle 6-hour rolling summary: hourly distillation of the last
      // ~6 h of activity. Same pattern as the 10m tick but at a slower
      // cadence and a longer window.
      label: "chronicle-6h-tick",
      delayMs: CHRONICLE_FIRST_TICK_DELAY_MS,
      run: () => {
        const runOnce = async () => {
          if (!(await isChronicleEnabled())) return;
          const runner = context.lifecycle.getRunner();
          if (!runner) return;
          let result;
          try {
            result = await runner.runChronicleSummaryTick("6h");
          } catch (error) {
            console.debug(
              "[chronicle] 6h tick failed:",
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          if (result.wrote) {
            void runner.triggerDreamNow("chronicle_summary").catch(() => {});
          }
        };
        void runOnce();
        context.state.processRuntime.setManagedInterval(() => {
          void runOnce();
        }, CHRONICLE_6H_TICK_INTERVAL_MS);
      },
    },
  ];
};

export const startDeferredStartup = (context: BootstrapContext) => {
  const { state } = context;

  if (state.deferredStartupSequence) {
    return state.deferredStartupSequence;
  }

  state.deferredStartupSequence = (async () => {
    for (const task of createDeferredStartupTasks(context)) {
      const completed = await runDeferredStartupTask(context, task);
      if (!completed) {
        return;
      }
    }
  })().catch((error) => {
    console.error(
      "[startup] Deferred startup failed:",
      (error as Error).message,
    );
  });

  return state.deferredStartupSequence;
};
