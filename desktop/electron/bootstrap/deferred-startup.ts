import { getSelectedText, initSelectedTextProcess } from "../selected-text.js";
import { requestAllMacPermissions } from "../utils/macos-permissions.js";
import { initializeWakeWord } from "../wake-word/initialize.js";
import {
  type BootstrapContext,
  broadcastWakeWordDetected,
  broadcastWakeWordState,
} from "./context.js";

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
      label: "permissions",
      run: async () => {
        try {
          await requestAllMacPermissions();
        } catch (error) {
          console.warn(
            "[permissions] Failed to request permissions:",
            (error as Error).message,
          );
        }
      },
    },
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
        services.radialGestureService.start();
      },
    },
    {
      label: "wake-word",
      delayMs: config.startupStageDelayMs,
      run: async () => {
        try {
          state.wakeWordController?.dispose();
          state.wakeWordController = await initializeWakeWord({
            isDev: config.isDev,
            electronDir: config.electronDir,
            uiStateService: services.uiStateService,
            isAppReady: () => state.appReady,
            onDetection: () => {
              broadcastWakeWordDetected(context);
            },
            onEnabledChange: () => {
              broadcastWakeWordState(context);
            },
          });
          broadcastWakeWordState(context);
        } catch (error) {
          console.error(
            "[WakeWord] Failed to initialize:",
            (error as Error).message,
          );
        }
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
