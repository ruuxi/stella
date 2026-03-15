import { promises as fs } from "fs";
import { app, session } from "electron";
import path from "path";
import { resetMessageStorage } from "../storage/reset-message-storage.js";
import { resolveRuntimeHomePath } from "../system/stella-home.js";
import { type BootstrapContext, broadcastLocalChatUpdated } from "./context.js";

export type BootstrapResetFlows = {
  hardResetLocalState: () => Promise<{ ok: true }>;
  resetLocalMessages: () => Promise<{ ok: true }>;
};

export const shutdownBootstrapRuntime = (
  context: BootstrapContext,
  options: { stopScheduler?: boolean } = {},
) => {
  const { state } = context;

  if (state.stellaHostRunner) {
    state.stellaHostRunner.stop();
    state.stellaHostRunner = null;
  }

  state.chatStore = null;
  state.runtimeStore = null;
  state.storeModStore = null;
  state.storeModService = null;
  state.desktopDatabase?.close();
  state.desktopDatabase = null;

  if (options.stopScheduler) {
    state.schedulerService?.stop();
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
    shutdownBootstrapRuntime(context, { stopScheduler: true });

    services.authService.setHostAuthState(false);
    state.appReady = false;
    services.authService.clearPendingAuthCallback();
    services.uiStateService.state.isVoiceActive = false;
    services.uiStateService.state.isVoiceRtcActive = false;
    services.uiStateService.syncVoiceOverlay();
    services.captureService.resetForHardReset();
    state.windowManager?.hideMiniWindow(false);

    services.securityPolicyService.clearAll();
    services.externalLinkService.clearSenderRateLimits();

    const appSession = session.fromPartition(config.sessionPartition);
    await Promise.allSettled([
      appSession.clearStorageData(),
      appSession.clearCache(),
    ]);

    const homePath = state.stellaHomePath ?? resolveRuntimeHomePath(app);
    await Promise.allSettled(
      config.hardResetMutableHomePaths.map((relativePath) =>
        fs.rm(path.join(homePath, relativePath), {
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

    if (!state.stellaHomePath) {
      return { ok: true };
    }

    shutdownBootstrapRuntime(context);
    await resetMessageStorage(state.stellaHomePath);
    await options.initializeStellaHostRunner();

    broadcastLocalChatUpdated(context);
    return { ok: true };
  },
});
