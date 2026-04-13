import { cleanupSelectedTextProcess } from "../selected-text.js";
import type { BootstrapContext } from "./context.js";

export const registerBootstrapProcessCleanups = (
  context: BootstrapContext,
) => {
  const { processRuntime } = context.state;

  processRuntime.registerCleanup("before-quit", "auth-refresh-loop", () => {
    context.services.authService.stopAuthRefreshLoop();
  });
  processRuntime.registerCleanup("before-quit", "runtime-shells", () => {
    context.state.stellaHostRunner?.killAllShells();
  });
  processRuntime.registerCleanup("before-quit", "browser-bridge", async () => {
    await context.state.stellaBrowserBridgeService?.stop();
  });
  processRuntime.registerCleanup("before-quit", "selected-text", () => {
    cleanupSelectedTextProcess();
  });
  processRuntime.registerCleanup("before-quit", "overlay-window", () => {
    context.state.overlayController?.destroy();
  });
  processRuntime.registerCleanup("before-quit", "mobile-bridge", async () => {
    await context.state.mobileBridgeResource?.stop();
  });
  processRuntime.registerCleanup("before-quit", "office-preview-bridge", () => {
    context.state.officePreviewBridgeStop?.();
    context.state.officePreviewBridgeStop = null;
  });
};
