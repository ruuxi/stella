import { app } from "electron";
import { hasMacPermission } from "../utils/macos-permissions.js";
import type { BootstrapContext } from "./context.js";

const GLOBAL_INPUT_HOOK_DELAY_MS = 1_500;

const canStartGlobalInputHooks = (context: BootstrapContext) => {
  if (!context.state.appReady) {
    return false;
  }
  if (process.platform === "darwin") {
    return hasMacPermission("accessibility", false);
  }
  return true;
};

export const scheduleGlobalInputHooksAfterAppReady = (
  context: BootstrapContext,
) => {
  if (
    context.state.globalInputHooksStarted ||
    context.state.globalInputHooksStartScheduled ||
    !canStartGlobalInputHooks(context)
  ) {
    return;
  }

  context.state.globalInputHooksStartScheduled = true;
  context.state.processRuntime.setManagedTimeout(() => {
    context.state.globalInputHooksStartScheduled = false;
    if (
      context.state.globalInputHooksStarted ||
      context.state.isQuitting ||
      context.state.processRuntime.isShuttingDown() ||
      !canStartGlobalInputHooks(context)
    ) {
      return;
    }

    context.services.radialGestureService.start();
    context.services.selectionWatcherService.start();
    context.state.globalInputHooksStarted = true;
  }, GLOBAL_INPUT_HOOK_DELAY_MS);
};

export const installGlobalInputHookFocusRetry = (context: BootstrapContext) => {
  if (process.platform !== "darwin") {
    return;
  }

  app.on("browser-window-focus", () => {
    scheduleGlobalInputHooksAfterAppReady(context);
  });
};
