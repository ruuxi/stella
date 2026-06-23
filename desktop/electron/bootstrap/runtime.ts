import { registerBootstrapIpcHandlers } from "./ipc.js";
import { createBootstrapResetFlows } from "./resets.js";
import { initializeStellaHostRunner } from "./host-runner.js";
import { type BootstrapContext } from "./context.js";
import {
  launchBootstrapAppShell,
  prepareBootstrapAppShell,
} from "./app-shell.js";
import { createManagedResource } from "../managed-resource.js";

const BACKGROUND_RUNTIME_RETRY_DELAY_MS = 2_000;

export const initializeBootstrapApplication = async (
  context: BootstrapContext,
) => {
  const { services } = context;

  services.authService.registerAuthProtocol();
  services.authService.captureInitialAuthUrl(process.argv);

  await prepareBootstrapAppShell(context);
  registerBootstrapIpcHandlers(
    context,
    createBootstrapResetFlows(context, {
      initializeStellaHostRunner: () => initializeStellaHostRunner(context),
    }),
  );
  launchBootstrapAppShell(context);

  // Defer the host runner (worker spawn + model-catalog warm) off the open
  // burst. Starting it inline here makes the Bun worker spawn + catalog fetch
  // contend with the renderer's first paint, which reads as a multi-second
  // stall right after the window appears. Instead we hand the starter to the
  // deferred-startup sequence, which fires once the renderer has painted
  // (did-finish-load, or the short fallback timeout). A chat started before
  // the warm completes still spawns the worker on demand, so this only
  // affects perceived open smoothness, not first-chat latency.
  const hostRunnerResource = createManagedResource<null>({
    processRuntime: context.state.processRuntime,
    canStart: () => !context.state.isQuitting,
    create: () => null,
    start: () => initializeStellaHostRunner(context),
    stop: async () => {},
    oneShot: true,
    retry: { fixedDelayMs: BACKGROUND_RUNTIME_RETRY_DELAY_MS },
    onError: (error) => {
      console.error(
        "[startup] Failed to initialize Stella host runner:",
        error,
      );
    },
  });
  context.state.startHostRunner = () => hostRunnerResource.start();
};
