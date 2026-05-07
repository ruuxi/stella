import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain, type BrowserWindow } from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { UiState } from "../types.js";
import type { WindowManager } from "../windows/window-manager.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import { createMonotonicSeqGenerator } from "./monotonic-seq.js";
import { applyShortcutRegistration } from "./shortcut-registration.js";
import type { VoiceRuntimeSnapshot } from "../../../runtime/contracts/index.js";
import {
  loadLocalPreferences,
  saveLocalPreferences,
} from "../../../runtime/kernel/preferences/local-preferences.js";

type VoiceHandlersOptions = {
  uiState: UiState;
  getAppReady: () => boolean;
  windowManager: WindowManager;
  getPetWindow?: () => BrowserWindow | null;
  broadcastUiState: () => void;
  /** Centralized "go to voice now" handler — opens the floating pet
   *  and toggles the realtime voice session. Voice no longer has its
   *  own creature overlay; the pet sprite animates listening /
   *  speaking instead. Wired the same way for the keybind, the radial
   *  dial wedge, and the pet's own mic action button. */
  togglePetVoice: () => void;
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null;
  getOverlayController?: () => OverlayWindowController | null;
  stellaRoot: string;
};

const DEFAULT_VOICE_RTC_SHORTCUT = "CommandOrControl+Shift+D";

const DEFAULT_RUNTIME_STATE: VoiceRuntimeSnapshot = {
  sessionState: "idle",
  isConnected: false,
  isSpeaking: false,
  isUserSpeaking: false,
  micLevel: 0,
  outputLevel: 0,
};

export const registerVoiceHandlers = (options: VoiceHandlersOptions) => {
  let currentVoiceRtcShortcut = "";
  let runtimeState: VoiceRuntimeSnapshot = DEFAULT_RUNTIME_STATE;
  const nextTaskEventSeq = createMonotonicSeqGenerator();

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

  const emitVoiceActionCompleted = (payload: {
    conversationId: string;
    status: "completed" | "failed";
    message: string;
  }) => {
    for (const window of options.windowManager.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send("voice:actionCompleted", payload);
    }
    options.getBroadcastToMobile?.()?.("voice:actionCompleted", payload);
  };

  let unsubscribeVoiceActionCompleted: (() => void) | null = null;
  const bindVoiceActionCompletion = (runner: StellaHostRunner | null) => {
    unsubscribeVoiceActionCompleted?.();
    unsubscribeVoiceActionCompleted = null;
    if (!runner) return;
    unsubscribeVoiceActionCompleted = runner.onVoiceActionCompleted((payload) => {
      emitVoiceActionCompleted(payload);
    });
  };
  bindVoiceActionCompletion(options.getStellaHostRunner());
  options.onStellaHostRunnerChanged?.(bindVoiceActionCompletion);

  const broadcastRuntimeState = () => {
    const windows = options.windowManager.getAllWindows();
    const petWindow = options.getPetWindow?.() ?? null;
    if (petWindow && !petWindow.isDestroyed() && !windows.includes(petWindow)) {
      windows.push(petWindow);
    }
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      window.webContents.send("voice:runtimeState", runtimeState);
    }
    options.getBroadcastToMobile?.()?.("voice:runtimeState", runtimeState);
  };

  const toggleVoiceRtc = () => {
    if (!options.getAppReady()) return;
    options.togglePetVoice();
  };

  const loadConfiguredShortcut = () => {
    return loadLocalPreferences(options.stellaRoot).voiceRtcShortcut;
  };

  const saveConfiguredShortcut = (shortcut: string) => {
    const prefs = loadLocalPreferences(options.stellaRoot);
    prefs.voiceRtcShortcut = shortcut;
    saveLocalPreferences(options.stellaRoot, prefs);
  };

  const initialVoiceRtcShortcut = applyShortcutRegistration({
    label: "Voice realtime",
    requestedShortcut: loadConfiguredShortcut(),
    currentShortcut: currentVoiceRtcShortcut,
    callback: toggleVoiceRtc,
  });
  currentVoiceRtcShortcut = initialVoiceRtcShortcut.activeShortcut;
  if (!initialVoiceRtcShortcut.ok) {
    console.warn("[voice]", initialVoiceRtcShortcut.error);
  }

  ipcMain.handle("voice-rtc:setShortcut", (_event, shortcut: string) => {
    const result = applyShortcutRegistration({
      label: "Voice realtime",
      requestedShortcut: shortcut,
      currentShortcut: currentVoiceRtcShortcut,
      callback: toggleVoiceRtc,
    });
    currentVoiceRtcShortcut = result.activeShortcut;
    if (!result.ok) {
      console.warn("[voice]", result.error);
    } else {
      saveConfiguredShortcut(result.activeShortcut);
    }
    return result;
  });

  ipcMain.handle("voice-rtc:getShortcut", () => currentVoiceRtcShortcut);

  ipcMain.handle("voice:getCoreMemory", async () => {
    try {
      return await fs.readFile(
        path.join(options.stellaRoot, "state", "core-memory.md"),
        "utf-8",
      );
    } catch {
      return null;
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
        uiVisibility?: "visible" | "hidden";
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
    async (
      _event,
      payload: { conversationId: string; message: string },
    ) => {
      console.log(
        `[${ts()}] [Voice] orchestratorChat request:`,
        payload.message,
      );
      if (!options.uiState.isVoiceRtcActive) {
        throw new Error("Voice mode is no longer active.");
      }
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
        onAgentEvent: (event) => {
          emitVoiceAgentEvent({
            type: event.type,
            runId: event.rootRunId ?? "voice",
            seq: nextTaskEventSeq(),
            agentId: event.agentId,
            agentType: event.agentType,
            description: event.description,
            parentAgentId: event.parentAgentId,
            result: event.result,
            error: event.error,
            statusText: event.statusText,
          });
        },
        onSelfModHmrState: (state) => {
          emitVoiceHmrState(state);
        },
        onRunFinished: (event) => {
          if (event.outcome === "error") {
            console.error(
              `[${ts()}] [Voice] orchestratorChat error:`,
              event.error ?? event.reason,
            );
          }
          emitVoiceAgentEvent({ ...event, type: "run-finished" });
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

};
