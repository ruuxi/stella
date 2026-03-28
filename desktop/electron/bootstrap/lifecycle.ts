import { app, globalShortcut } from "electron";
import type { BootstrapContext } from "./context.js";
import { shutdownBootstrapRuntime } from "./resets.js";
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
  context.state.processRuntime.registerCleanup(
    "will-quit",
    "global-shortcuts",
    () => {
      globalShortcut.unregisterAll();
    },
  );
  context.state.processRuntime.registerCleanup(
    "will-quit",
    "radial-gesture-service",
    () => {
      context.services.radialGestureService.stop();
    },
  );
  context.state.processRuntime.registerCleanup(
    "will-quit",
    "bootstrap-runtime",
    async () => {
      await shutdownBootstrapRuntime(context, { stopScheduler: true });
    },
  );

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
    void context.state.processRuntime.runPhase("before-quit");
  });

  app.on("will-quit", () => {
    void context.state.processRuntime.runPhase("will-quit");
  });
};
