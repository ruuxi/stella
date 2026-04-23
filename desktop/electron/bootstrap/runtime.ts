import { registerBootstrapIpcHandlers } from "./ipc.js";
import { createBootstrapResetFlows } from "./resets.js";
import { initializeStellaHostRunner } from "./host-runner.js";
import { type BootstrapContext } from "./context.js";
import { initializeBootstrapAppShell } from "./app-shell.js";
import { startStellaBrowserBridge } from "./aux-runtime.js";
import { createManagedResource } from "../managed-resource.js";

const BACKGROUND_RUNTIME_RETRY_DELAY_MS = 2_000;

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
  createManagedResource<null>({
    processRuntime: context.state.processRuntime,
    canStart: () => !context.state.isQuitting,
    create: () => null,
    start: () => initializeStellaHostRunner(context),
    stop: async () => {},
    oneShot: true,
    retry: { fixedDelayMs: BACKGROUND_RUNTIME_RETRY_DELAY_MS },
    onError: (error) => {
      console.error("[startup] Failed to initialize Stella host runner:", error);
    },
  }).start();
};
