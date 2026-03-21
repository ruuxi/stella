import { app, globalShortcut } from "electron";
import { cleanupSelectedTextProcess } from "../selected-text.js";
import type { BootstrapContext } from "./context.js";
import { scheduleBootstrapRuntimeShutdown } from "./resets.js";
import { initializeBootstrapApplication } from "./runtime.js";

export const initializeBootstrapSingleInstance = (
  context: BootstrapContext,
) => {
  if (!context.services.authService.enforceSingleInstanceLock()) {
    return false;
  }

  context.services.authService.bindOpenUrlHandler();
  return true;
};

export const registerBootstrapLifecycle = (context: BootstrapContext) => {
  app.whenReady().then(async () => {
    await initializeBootstrapApplication(context);

    app.on("activate", () => {
      context.state.windowManager?.onActivate();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    context.state.isQuitting = true;
    context.services.authService.stopAuthRefreshLoop();
    void context.services.devProjectService.stopAll();
    context.state.stellaHostRunner?.killAllShells();
    context.state.wakeWordController?.dispose();
    context.state.wakeWordController = null;
    cleanupSelectedTextProcess();
    context.state.overlayController?.destroy();
    context.state.mobileBridgeService?.stop();
    context.state.devToolServer?.stop();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    context.services.radialGestureService.stop();
    scheduleBootstrapRuntimeShutdown(context, { stopScheduler: true });
  });
};
