import { promises as fs } from "fs";
import { session } from "electron";
import path from "path";
import { resetMessageStorage } from "../../../runtime/kernel/storage/reset-message-storage.js";
import { type BootstrapContext, broadcastLocalChatUpdated } from "./context.js";

export type BootstrapResetFlows = {
  hardResetLocalState: () => Promise<{ ok: true }>;
  resetLocalMessages: () => Promise<{ ok: true }>;
  shutdownRuntime: () => Promise<void>;
  restartRuntime: () => Promise<void>;
};

export const scheduleBootstrapRuntimeShutdown = (
  context: BootstrapContext,
  options: { stopScheduler?: boolean } = {},
) => {
  return void shutdownBootstrapRuntime(context, options).catch((error) => {
    console.error(
      "Failed to shut down Stella runtime during scheduled shutdown.",
      error,
    );
  });
};

export const shutdownBootstrapRuntime = async (
  context: BootstrapContext,
  options: { stopScheduler?: boolean } = {},
) => {
  const { lifecycle, state } = context;

  state.localChatUpdateUnsubscribe?.();
  state.localChatUpdateUnsubscribe = null;
  state.scheduleUpdateUnsubscribe?.();
  state.scheduleUpdateUnsubscribe = null;

  if (state.stellaHostRunner) {
    const runner = state.stellaHostRunner;
    if (lifecycle) {
      lifecycle.setRunner(null);
    } else {
      state.stellaHostRunner = null;
    }
    await runner.stop();
  }
};

export const createBootstrapResetFlows = (
  context: BootstrapContext,
  options: {
    initializeStellaHostRunner: () => Promise<void>;
  },
): BootstrapResetFlows => ({
  hardResetLocalState: async () => {
    const { config, services, state } = context;
    const hadRunner = Boolean(state.stellaHostRunner);

    services.credentialService.cancelAll();
    await shutdownBootstrapRuntime(context, { stopScheduler: true });

    services.authService.setHostAuthState(false);
    state.appReady = false;
    services.authService.clearPendingAuthCallback();
    services.uiStateService.state.isVoiceRtcActive = false;
    services.uiStateService.syncVoiceOverlay();
    services.captureService.resetForHardReset();
    state.windowManager?.restoreFullSize();

    services.securityPolicyService.clearAll();
    services.externalLinkService.clearSenderRateLimits();

    const appSession = session.fromPartition(config.sessionPartition);
    await Promise.allSettled([
      appSession.clearStorageData(),
      appSession.clearCache(),
    ]);

    const stellaStatePath = state.stellaStatePath;
    if (!stellaStatePath) {
      throw new Error("Cannot hard reset before Stella state is initialized.");
    }
    await Promise.allSettled(
      config.hardResetMutableHomePaths.map((relativePath) =>
        fs.rm(path.join(stellaStatePath, relativePath), {
          recursive: true,
          force: true,
        }),
      ),
    );

    if (hadRunner) {
      await options.initializeStellaHostRunner();
    }

    services.uiStateService.broadcast();
    return { ok: true };
  },
  resetLocalMessages: async () => {
    const { state } = context;

    if (!state.stellaStatePath) {
      throw new Error("Cannot reset messages before Stella state is initialized.");
    }

    await shutdownBootstrapRuntime(context);
    await resetMessageStorage(state.stellaStatePath);
    await options.initializeStellaHostRunner();

    broadcastLocalChatUpdated(context);
    return { ok: true };
  },
  shutdownRuntime: async () => {
    await shutdownBootstrapRuntime(context, { stopScheduler: true });
  },
  restartRuntime: async () => {
    await shutdownBootstrapRuntime(context, { stopScheduler: true });
    await options.initializeStellaHostRunner();
  },
});
