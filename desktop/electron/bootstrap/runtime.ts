import { registerBootstrapIpcHandlers } from "./ipc.js";
import { createBootstrapResetFlows } from "./resets.js";
import { initializeStellaHostRunner } from "./host-runner.js";
import { createHostRunnerResource } from "../process-resources/host-runner-resource.js";
import { type BootstrapContext } from "./context.js";
import { initializeBootstrapAppShell } from "./app-shell.js";
import { startStellaBrowserBridge } from "./aux-runtime.js";

export const initializeBootstrapApplication = async (
  context: BootstrapContext,
) => {
  const { services } = context;

  services.authService.registerAuthProtocol();
  services.authService.captureInitialAuthUrl(process.argv);

  await initializeBootstrapAppShell(context);
  registerBootstrapIpcHandlers(
    context,
    createBootstrapResetFlows(context, {
      initializeStellaHostRunner: () => initializeStellaHostRunner(context),
    }),
  );

  startStellaBrowserBridge(context);
  createHostRunnerResource({
    processRuntime: context.state.processRuntime,
    isQuitting: () => context.state.isQuitting,
    initializeHostRunner: () => initializeStellaHostRunner(context),
  }).start();
};
