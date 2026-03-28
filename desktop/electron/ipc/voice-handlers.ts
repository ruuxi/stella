import { globalShortcut, ipcMain } from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { UiState } from "../types.js";
import type { WindowManager } from "../windows/window-manager.js";

type VoiceHandlersOptions = {
  uiState: UiState;
  getAppReady: () => boolean;
  windowManager: WindowManager;
  broadcastUiState: () => void;
  scheduleResumeWakeWord: () => void;
  syncVoiceOverlay: () => void;
  syncWakeWordState: () => boolean;
  getWakeWordEnabled: () => boolean;
  pushWakeWordAudio: (pcm: Int16Array) => void;
  getStellaHostRunner: () => StellaHostRunner | null;
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null;
};

type VoiceRuntimeSnapshot = {
  sessionState: "idle" | "connecting" | "connected" | "error" | "disconnecting";
  isConnected: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
};

const DEFAULT_RUNTIME_STATE: VoiceRuntimeSnapshot = {
  sessionState: "idle",
  isConnected: false,
  isSpeaking: false,
  isUserSpeaking: false,
  micLevel: 0,
  outputLevel: 0,
};

type ShortcutRegistrationResult = {
  ok: boolean;
  requestedShortcut: string;
  activeShortcut: string;
  error?: string;
};

export const registerVoiceHandlers = (options: VoiceHandlersOptions) => {
  let currentVoiceRtcShortcut = "";
  let runtimeState: VoiceRuntimeSnapshot = DEFAULT_RUNTIME_STATE;

  const ts = () => {
    const d = new Date();
    return `${d.toLocaleTimeString("en-US", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };

  const applyShortcutRegistration = (
    label: string,
    requestedShortcut: string,
    currentShortcut: string,
    toggle: () => void,
  ): ShortcutRegistrationResult => {
    if (requestedShortcut === currentShortcut) {
      return {
        ok: true,
        requestedShortcut,
        activeShortcut: currentShortcut,
      };
    }

    if (currentShortcut) {
      globalShortcut.unregister(currentShortcut);
    }

    if (!requestedShortcut) {
      return {
        ok: true,
        requestedShortcut,
        activeShortcut: "",
      };
    }

    let registrationError: string | undefined;
    try {
      const registered = globalShortcut.register(requestedShortcut, toggle);
      if (registered) {
        return {
          ok: true,
          requestedShortcut,
          activeShortcut: requestedShortcut,
        };
      }
      registrationError = `${label} shortcut "${requestedShortcut}" is unavailable.`;
    } catch (error) {
      registrationError =
        error instanceof Error
          ? error.message
          : `${label} shortcut "${requestedShortcut}" is unavailable.`;
    }

    let restoredShortcut = "";
    if (currentShortcut) {
      try {
        if (globalShortcut.register(currentShortcut, toggle)) {
          restoredShortcut = currentShortcut;
        }
      } catch {
        restoredShortcut = "";
      }
    }

    return {
      ok: false,
      requestedShortcut,
      activeShortcut: restoredShortcut,
      error: restoredShortcut
        ? `${registrationError} Kept "${restoredShortcut}" active instead.`
        : `${registrationError} No fallback shortcut is active.`,
    };
  };

  const broadcastRuntimeState = () => {
    for (const window of options.windowManager.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send("voice:runtimeState", runtimeState);
    }
    options.getBroadcastToMobile?.()?.("voice:runtimeState", runtimeState);
  };

  const toggleVoiceRtc = () => {
    if (!options.getAppReady()) return;
    options.uiState.isVoiceRtcActive = !options.uiState.isVoiceRtcActive;
    if (options.uiState.isVoiceRtcActive) {
      options.uiState.mode = "voice";
    } else {
      options.scheduleResumeWakeWord();
    }
    options.syncVoiceOverlay();
    options.broadcastUiState();
    options.syncWakeWordState();
  };

  const initialVoiceRtcShortcut = applyShortcutRegistration(
    "Voice realtime",
    "CommandOrControl+Shift+D",
    currentVoiceRtcShortcut,
    toggleVoiceRtc,
  );
  currentVoiceRtcShortcut = initialVoiceRtcShortcut.activeShortcut;
  if (!initialVoiceRtcShortcut.ok) {
    console.warn("[voice]", initialVoiceRtcShortcut.error);
  }

  ipcMain.handle("voice-rtc:setShortcut", (_event, shortcut: string) => {
    const result = applyShortcutRegistration(
      "Voice realtime",
      shortcut,
      currentVoiceRtcShortcut,
      toggleVoiceRtc,
    );
    currentVoiceRtcShortcut = result.activeShortcut;
    if (!result.ok) {
      console.warn("[voice]", result.error);
    }
    return result;
  });

  ipcMain.on(
    "voice:persistTranscript",
    (
      _event,
      payload: {
        conversationId: string;
        role: "user" | "assistant";
        text: string;
      },
    ) => {
      console.log(
        `[${ts()}] [Voice RTC] ${payload.role.toUpperCase()}: ${payload.text}`,
      );
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        return;
      }
      stellaHostRunner.persistVoiceTranscript(payload).catch((err) => {
        console.debug(
          "[voice] transcript persistence failed (best-effort):",
          (err as Error).message,
        );
      });
    },
  );

  ipcMain.handle(
    "voice:executeTool",
    async (
      _event,
      payload: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        conversationId: string;
        callId: string;
      },
    ) => {
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        return { result: "", error: "Stella runtime not initialized" };
      }
      return await stellaHostRunner.voiceExecuteTool(payload);
    },
  );

  ipcMain.handle("voice:getRuntimeState", () => runtimeState);

  ipcMain.handle("voice:getWakeWordState", () => ({
    enabled: options.getWakeWordEnabled(),
  }));

  ipcMain.on("voice:wakeWordAudio", (_event, buffer: ArrayBuffer) => {
    if (!(buffer instanceof ArrayBuffer)) {
      return;
    }
    options.pushWakeWordAudio(new Int16Array(buffer));
  });

  ipcMain.on(
    "voice:runtimeState",
    (_event, nextState: VoiceRuntimeSnapshot) => {
      runtimeState = {
        sessionState: nextState?.sessionState ?? "idle",
        isConnected: Boolean(nextState?.isConnected),
        isSpeaking: Boolean(nextState?.isSpeaking),
        isUserSpeaking: Boolean(nextState?.isUserSpeaking),
        micLevel: Number.isFinite(nextState?.micLevel)
          ? Math.max(0, Number(nextState.micLevel))
          : 0,
        outputLevel: Number.isFinite(nextState?.outputLevel)
          ? Math.max(0, Number(nextState.outputLevel))
          : 0,
      };
      broadcastRuntimeState();
    },
  );

  ipcMain.on("app:setReady", () => {
    options.syncWakeWordState();
  });
};
