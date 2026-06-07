import { ChronicleController } from "../services/chronicle-controller.js";
import { type BootstrapContext } from "./context.js";
import { getMainLogger } from "../observability/main-logger.js";

// Chronicle refreshes the rolling 10-min summary once per minute and the
// rolling 6-hour summary once per hour.
const CHRONICLE_10M_TICK_INTERVAL_MS = 60_000;
const CHRONICLE_6H_TICK_INTERVAL_MS = 60 * 60_000;
// Wait this long after startup before the first 10m tick fires, to avoid
// summarizing pre-startup or near-empty capture windows. Phase-2 consolidation
// runs at app startup once Phase 1 catches up, not on a wall-clock interval.
const CHRONICLE_FIRST_TICK_DELAY_MS = 30_000;
const DREAM_READY_RETRY_MS = 5_000;

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

  if (
    context.state.isQuitting ||
    context.state.processRuntime.isShuttingDown()
  ) {
    return false;
  }

  await task.run();
  return true;
};

const triggerDreamWhenAgentReady = (
  context: BootstrapContext,
  trigger: "startup_catchup",
): void => {
  const runner = context.lifecycle.getRunner();
  if (!runner) {
    return;
  }

  void (async () => {
    const health = await runner.agentHealthCheck();
    if (!health?.ready) {
      context.state.processRuntime.setManagedTimeout(() => {
        triggerDreamWhenAgentReady(context, trigger);
      }, DREAM_READY_RETRY_MS);
      return;
    }

    await runner.triggerDreamNow(trigger);
  })().catch((error) => {
    console.debug(
      "[dream] trigger failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
};

const createDeferredStartupTasks = (
  context: BootstrapContext,
): DeferredStartupTask[] => {
  const { config, state } = context;
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
      // Spin up the runtime worker (and warm the model catalog) only after
      // the renderer has painted, so the spawn + catalog fetch don't contend
      // with first paint. `startHostRunner` is idempotent and the worker is
      // spawned on demand if a chat beats this, so deferring is safe.
      label: "host-runner",
      run: () => {
        getMainLogger()?.process("startup.host-runner.kickoff", {
          elapsedMs: Math.round(process.uptime() * 1000),
        });
        state.startHostRunner?.();
      },
    },
    {
      // Push the overlay's cold second-renderer boot past first paint + the
      // host-runner kickoff above, so it doesn't overlap main-window TTI +
      // worker spawn. The overlay is only needed on-demand (radial/voice).
      label: "overlay-window",
      delayMs: config.startupStageDelayMs,
      run: () => {
        state.overlayController?.create();
      },
    },
    {
      label: "chronicle-daemon",
      delayMs: config.startupStageDelayMs,
      run: async () => {
        const stellaHome = state.stellaHomePath;
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
      // immediately on startup, not 60 seconds later.
      label: "dream-startup-sweep",
      delayMs: config.startupStageDelayMs,
      run: () => {
        triggerDreamWhenAgentReady(context, "startup_catchup");
      },
    },
    {
      // Chronicle 10-minute rolling summary: distill the last ~10 min of OCR
      // deltas every minute and write the file. Dream is not poked here — the
      // refreshed file just accumulates and is folded on the next
      // orchestrator-driven Dream run (token-interval / pre-compaction).
      label: "chronicle-10m-tick",
      delayMs: CHRONICLE_FIRST_TICK_DELAY_MS,
      run: () => {
        const runOnce = async () => {
          if (!(await isChronicleEnabled())) return;
          const runner = context.lifecycle.getRunner();
          if (!runner) return;
          try {
            await runner.runChronicleSummaryTick("10m");
          } catch (error) {
            console.debug(
              "[chronicle] 10m tick failed:",
              error instanceof Error ? error.message : String(error),
            );
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
      // cadence and a longer window. Also does not poke Dream.
      label: "chronicle-6h-tick",
      delayMs: CHRONICLE_FIRST_TICK_DELAY_MS,
      run: () => {
        const runOnce = async () => {
          if (!(await isChronicleEnabled())) return;
          const runner = context.lifecycle.getRunner();
          if (!runner) return;
          try {
            await runner.runChronicleSummaryTick("6h");
          } catch (error) {
            console.debug(
              "[chronicle] 6h tick failed:",
              error instanceof Error ? error.message : String(error),
            );
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
