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
const OVERLAY_STARTUP_WARM_DELAY_MS = 5_000;

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

// Synchronous, disk-free check used by the per-tick guard below. Backed by the
// controller's in-memory enabled cache so it reflects a runtime enable/disable
// without reading preferences.json every tick.
const isChronicleEnabled = (context: BootstrapContext): boolean =>
  context.state.chronicleController?.isEnabledCached() ?? false;

// Perf: the rolling-summary interval is armed once at startup and stays alive,
// but the expensive part (asking the runner to summarize) only runs while
// Chronicle/Live Memory is enabled. We deliberately do NOT skip arming when
// disabled, nor self-cancel on disable: doing either breaks the common case
// where the user turns Live Memory ON mid-session (the timer would never have
// started, so summaries would never resume). The per-tick gate reads an
// in-memory flag (no disk I/O), and the timer is unref'd via
// `setManagedInterval`, so an always-disabled session only pays a no-op wakeup
// every minute (10m) / hour (6h).
const armChronicleTick = (
  context: BootstrapContext,
  window: "10m" | "6h",
  intervalMs: number,
): void => {
  const runOnce = async () => {
    if (!isChronicleEnabled(context)) return;
    const runner = context.lifecycle.getRunner();
    if (!runner) return;
    try {
      await runner.runChronicleSummaryTick(window);
    } catch (error) {
      console.debug(
        `[chronicle] ${window} tick failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  void runOnce();
  context.state.processRuntime.setManagedInterval(() => {
    void runOnce();
  }, intervalMs);
};

const scheduleOverlayWarmup = (context: BootstrapContext): void => {
  const { state } = context;
  state.processRuntime.setManagedTimeout(() => {
    void (async () => {
      if (state.isQuitting || state.processRuntime.isShuttingDown()) {
        return;
      }

      const warmed = await state.overlayController?.warmForStartup();
      getMainLogger()?.process("startup.overlay-warmup", {
        warmed: warmed === true,
        elapsedMs: Math.round(process.uptime() * 1000),
      });
    })().catch((error) => {
      console.debug(
        "[startup] Overlay warmup failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, OVERLAY_STARTUP_WARM_DELAY_MS);
};

const createDeferredStartupTasks = (
  context: BootstrapContext,
): DeferredStartupTask[] => {
  const { config, state } = context;

  // Perf: the overlay's cold second-renderer is no longer eagerly built here.
  // Every overlay show entrypoint (radial/voice/region-capture/screen-guide/
  // selection-chip/morph/window-highlight) self-creates the window via
  // `OverlayWindowController.ensureReady()`. Startup schedules a delayed warm
  // so first use is usually ready without competing with first paint.
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
      label: "overlay-warmup-schedule",
      run: () => {
        scheduleOverlayWarmup(context);
      },
    },
    {
      label: "chronicle-daemon",
      delayMs: config.startupStageDelayMs,
      run: async () => {
        const stellaDataDir = state.stellaDataDirPath;
        if (!stellaDataDir) return;
        if (!state.chronicleController) {
          state.chronicleController = new ChronicleController(stellaDataDir);
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
      run: () => armChronicleTick(context, "10m", CHRONICLE_10M_TICK_INTERVAL_MS),
    },
    {
      // Chronicle 6-hour rolling summary: hourly distillation of the last
      // ~6 h of activity. Same pattern as the 10m tick but at a slower
      // cadence and a longer window. Also does not poke Dream.
      label: "chronicle-6h-tick",
      delayMs: CHRONICLE_FIRST_TICK_DELAY_MS,
      run: () => armChronicleTick(context, "6h", CHRONICLE_6H_TICK_INTERVAL_MS),
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
