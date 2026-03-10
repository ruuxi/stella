import path from "path";
import { ipcMain } from "electron";
import type { UiStateService } from "../services/ui-state-service.js";

export type WakeWordDeps = {
  isDev: boolean;
  electronDir: string;
  uiStateService: UiStateService;
  isAppReady: () => boolean;
  onEnabledChange?: (enabled: boolean) => void;
};

export type WakeWordController = {
  pushAudioChunk: (pcm: Int16Array) => void;
  syncState: () => boolean;
  getEnabled: () => boolean;
  dispose: () => void;
};

export const initializeWakeWord = async (
  deps: WakeWordDeps,
): Promise<WakeWordController> => {
  const { createWakeWordDetector } = await import("./detector.js");
  const { createWakeWordAudioFeedManager } = await import("./audio-feed.js");

  const modelsDir = deps.isDev
    ? path.join(deps.electronDir, "..", "..", "resources", "models")
    : path.join(process.resourcesPath, "models");

  const detector = await createWakeWordDetector(modelsDir);
  const feed = createWakeWordAudioFeedManager(detector);
  let lastEnabled = false;

  const shouldEnableWakeWord = () =>
    deps.isAppReady() &&
    !deps.uiStateService.state.isVoiceActive &&
    !deps.uiStateService.state.isVoiceRtcActive;

  const publishEnabledState = (enabled: boolean) => {
    if (lastEnabled === enabled) {
      return;
    }
    lastEnabled = enabled;
    deps.onEnabledChange?.(enabled);
  };

  const syncState = () => {
    const shouldListen = shouldEnableWakeWord();
    if (shouldListen) {
      if (!feed.isListening()) {
        void feed
          .start()
          .then(() => {
            publishEnabledState(true);
          })
          .catch((error) => {
            console.error(
              "[WakeWord] Failed to start listening:",
              (error as Error).message,
            );
            publishEnabledState(false);
          });
      } else {
        publishEnabledState(true);
      }
    } else if (feed.isListening()) {
      feed.stop();
      publishEnabledState(false);
    } else {
      publishEnabledState(false);
    }
    return shouldListen;
  };

  feed.onDetection(() => {
    if (!deps.isAppReady()) return;

    const convId = deps.uiStateService.state.conversationId ?? "voice-rtc";
    deps.uiStateService.activateVoiceRtc(
      convId !== "voice-rtc" ? convId : null,
    );
    feed.stop();
    publishEnabledState(false);
  });

  if (deps.isAppReady()) {
    setTimeout(() => {
      syncState();
    }, 150);
  }
  ipcMain.on("app:setReady", () => {
    setTimeout(() => {
      syncState();
    }, 150);
  });

  deps.uiStateService.setResumeWakeWordCapture(() => {
    setTimeout(() => {
      syncState();
    }, 150);
  });

  publishEnabledState(false);

  return {
    pushAudioChunk: (pcm: Int16Array) => {
      feed.pushAudio(pcm);
    },
    syncState,
    getEnabled: () => feed.isListening(),
    dispose: () => {
      feed.dispose();
      publishEnabledState(false);
    },
  };
};
