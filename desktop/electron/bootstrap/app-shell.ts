import { app } from "electron";
import path from "path";
import { resolveStellaHome } from "../../packages/runtime-kernel/home/stella-home.js";
import {
  type BootstrapContext,
  broadcastAuthCallback,
} from "./context.js";
import { startDeferredStartup } from "./deferred-startup.js";
import { initializeBootstrapWindowShell } from "./window-shell.js";

const initializeBootstrapLocalState = async (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const stellaHome = await resolveStellaHome(app);

  lifecycle.setStellaHomePath(stellaHome.homePath);
  state.stellaHomePath = stellaHome.homePath;
  state.stellaWorkspacePath = stellaHome.workspacePath;

  services.securityPolicyService.setSecurityPolicyPath(
    path.join(stellaHome.statePath, "security_policy.json"),
  );
};

const finalizeWindowLaunch = (context: BootstrapContext) => {
  const { config, services, state } = context;

  state.windowManager!.createInitialWindows();

  const pendingAuthCallback = services.authService.consumePendingAuthCallback();
  const fullWindow = state.windowManager!.getFullWindow();

  if (pendingAuthCallback && fullWindow) {
    fullWindow.webContents.once("did-finish-load", () => {
      broadcastAuthCallback(context, pendingAuthCallback);
    });
  }

  if (fullWindow) {
    fullWindow.webContents.once("did-finish-load", () => {
      void startDeferredStartup(context);
    });
  }

  state.windowManager!.showWindow("full");
  context.state.processRuntime.setManagedTimeout(() => {
    void startDeferredStartup(context);
  }, config.startupStageDelayMs);
};

export const initializeBootstrapAppShell = async (
  context: BootstrapContext,
) => {
  await initializeBootstrapLocalState(context);
  initializeBootstrapWindowShell(context);
  finalizeWindowLaunch(context);
};
