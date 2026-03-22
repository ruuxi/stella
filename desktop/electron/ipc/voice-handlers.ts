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
  let currentVoiceShortcut = "";
  let currentVoiceRtcShortcut = "";
  let runtimeState: VoiceRuntimeSnapshot = DEFAULT_RUNTIME_STATE;

  const ts = () => {
    const d = new Date();
    return `${d.toLocaleTimeString("en-US", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };

  const emitVoiceAgentEvent = (eventPayload: Record<string, unknown>) => {
    const fullWindow = options.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send("agent:event", eventPayload);
    }
    options.getBroadcastToMobile?.()?.("agent:event", eventPayload);
  };

  const emitVoiceHmrState = (state: unknown) => {
    const miniWindow = options.windowManager.getMiniWindow();
    const fullWindow = options.windowManager.getFullWindow();
    const targetWindow =
      options.uiState.window === "mini"
        ? (miniWindow ?? fullWindow)
        : (fullWindow ?? miniWindow);
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("agent:selfModHmrState", state);
    }
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

  const toggleVoice = () => {
    if (!options.getAppReady()) return;
    options.uiState.isVoiceActive = !options.uiState.isVoiceActive;
    if (options.uiState.isVoiceActive) {
      options.uiState.isVoiceRtcActive = false;
      options.uiState.mode = "voice";
    } else {
      options.scheduleResumeWakeWord();
    }
    options.syncVoiceOverlay();
    options.broadcastUiState();
    options.syncWakeWordState();
  };

  const toggleVoiceRtc = () => {
    if (!options.getAppReady()) return;
    options.uiState.isVoiceRtcActive = !options.uiState.isVoiceRtcActive;
    if (options.uiState.isVoiceRtcActive) {
      options.uiState.isVoiceActive = false;
      options.uiState.mode = "voice";
    } else {
      options.scheduleResumeWakeWord();
    }
    options.syncVoiceOverlay();
    options.broadcastUiState();
    options.syncWakeWordState();
  };

  const initialVoiceShortcut = applyShortcutRegistration(
    "Voice",
    "CommandOrControl+Shift+V",
    currentVoiceShortcut,
    toggleVoice,
  );
  currentVoiceShortcut = initialVoiceShortcut.activeShortcut;
  if (!initialVoiceShortcut.ok) {
    console.warn("[voice]", initialVoiceShortcut.error);
  }

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

  ipcMain.handle("voice:setShortcut", (_event, shortcut: string) => {
    const result = applyShortcutRegistration(
      "Voice",
      shortcut,
      currentVoiceShortcut,
      toggleVoice,
    );
    currentVoiceShortcut = result.activeShortcut;
    if (!result.ok) {
      console.warn("[voice]", result.error);
    }
    return result;
  });

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

  ipcMain.on("voice:transcript", (_event, transcript: string) => {
    console.log(`[${ts()}] [Voice] Transcript:`, transcript);
    const miniWindow = options.windowManager.getMiniWindow();
    const fullWindow = options.windowManager.getFullWindow();
    const preferredWindow =
      options.uiState.window === "mini"
        ? (miniWindow ?? fullWindow)
        : (fullWindow ?? miniWindow);

    if (preferredWindow && !preferredWindow.isDestroyed()) {
      preferredWindow.webContents.send("voice:transcript", transcript);
    }
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
    "voice:orchestratorChat",
    async (_event, payload: { conversationId: string; message: string }) => {
      console.log(
        `[${ts()}] [Voice] orchestratorChat request:`,
        payload.message,
      );
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not initialized");
      }

      return await stellaHostRunner.handleVoiceChat(payload, {
        onStream: () => {},
        onToolStart: (event) => {
          emitVoiceAgentEvent({ ...event, type: "tool-start" });
        },
        onToolEnd: (event) => {
          emitVoiceAgentEvent({ ...event, type: "tool-end" });
        },
        onTaskEvent: (event) => {
          emitVoiceAgentEvent({
            type: event.type,
            runId: event.rootRunId ?? "voice",
            seq: Date.now(),
            taskId: event.taskId,
            agentType: event.agentType,
            description: event.description,
            parentTaskId: event.parentTaskId,
            result: event.result,
            error: event.error,
            statusText: event.statusText,
          });
        },
        onSelfModHmrState: (state) => {
          emitVoiceHmrState(state);
        },
        onEnd: (event) => {
          emitVoiceAgentEvent({ ...event, type: "end" });
        },
        onError: (event) => {
          console.error(
            `[${ts()}] [Voice] orchestratorChat error:`,
            event.error,
          );
          emitVoiceAgentEvent({ ...event, type: "error" });
        },
      });
    },
  );

  ipcMain.handle(
    "voice:webSearch",
    async (
      _event,
      payload: {
        query: string;
        category?: string;
      },
    ) => {
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        return { text: "Stella runtime not initialized.", results: [] };
      }
      return await stellaHostRunner.voiceWebSearch(payload);
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
