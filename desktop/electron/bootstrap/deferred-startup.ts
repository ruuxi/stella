import { getSelectedText, initSelectedTextProcess } from "../selected-text.js";
import { hasMacPermission } from "../utils/macos-permissions.js";
import { type BootstrapContext } from "./context.js";

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
