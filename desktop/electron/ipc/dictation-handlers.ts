/**
 * Dictation IPC handlers.
 *
 * Owns global speech-to-text dictation. Option/Alt is handled as push-to-talk
 * through the low-level input hook; other configured shortcuts use Electron's
 * toggle-style globalShortcut path.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  screen,
  systemPreferences,
} from "electron";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WindowManager } from "../windows/window-manager.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import {
  getDictationSoundEffectsEnabled,
  loadLocalPreferences,
  saveLocalPreferences,
} from "../../../runtime/kernel/preferences/local-preferences.js";
import { runNativeHelper } from "../native-helper.js";
import {
  applyShortcutRegistration,
  type ShortcutRegistrationResult,
} from "./shortcut-registration.js";
import {
  getLocalParakeetStatus,
  transcribeWithLocalParakeet,
  warmLocalParakeet,
} from "../dictation/local-parakeet.js";

const DEFAULT_DICTATION_SHORTCUT = "Alt";
const DEFAULT_NON_MAC_DICTATION_SHORTCUT = "Control+M";
const LEGACY_DEFAULT_DICTATION_SHORTCUT = "Control+M";
const PUSH_TO_TALK_DICTATION_SHORTCUT = "Alt";
const PUSH_TO_TALK_MIN_DURATION_MS = 300;
const DICTATION_SOUND_VOLUME_BY_SOUND = {
  startRecording: "0.2",
  stopRecording: "0.45",
  pasteTranscript: "0.35",
  cancel: "0.35",
} satisfies Record<DictationSound, string>;
const DICTATION_START_SOUND_MUTE_DELAY_MS = 220;
const CLIPBOARD_SETTLE_MS = 150;
const PASTE_SETTLE_MS = 700;
const IN_APP_START_ACK_TIMEOUT_MS = 150;
const DICTATION_BRIDGE_TIMEOUT_MS = 2_000;

const execFileAsync = promisify(execFile);

type DictationHandlersOptions = {
  windowManager: WindowManager;
  getOverlayController: () => OverlayWindowController | null;
  getStellaRoot: () => string | null;
  onDictationActiveChanged?: (active: boolean) => void;
};

type DictationMode =
  | { type: "in-app"; window: BrowserWindow; startId: string }
  | { type: "overlay"; sessionId: string };

export type DictationPushToTalkController = {
  isEnabled: () => boolean;
  start: () => void;
  reveal: () => void;
  stop: (durationMs: number) => void;
  cancel: () => void;
  discard: () => void;
};

type DictationSound =
  | "startRecording"
  | "stopRecording"
  | "pasteTranscript"
  | "cancel";

type DictationMuteResult = {
  ok?: boolean;
  previousVolume?: number;
  previousMuted?: boolean;
};

const dictationBridgeIsSupported = () =>
  process.platform === "darwin" || process.platform === "win32";

const isUsableWindow = (
  window: BrowserWindow | null,
): window is BrowserWindow => Boolean(window && !window.isDestroyed());

type ClipboardSnapshot = {
  formats: Array<{ format: string; data: Buffer }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readClipboardSnapshot = (): ClipboardSnapshot => ({
  formats: clipboard.availableFormats().map((format) => ({
    format,
    data: clipboard.readBuffer(format),
  })),
});

const restoreClipboardSnapshot = (snapshot: ClipboardSnapshot) => {
  clipboard.clear();
  for (const item of snapshot.formats) {
    clipboard.writeBuffer(item.format, item.data);
  }
};

const issuePasteKeystroke = async () => {
  if (process.platform === "darwin") {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      throw new Error(
        "Accessibility permission is required to paste dictation.",
      );
    }
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-STA",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ]);
    return;
  }

  throw new Error("OS-wide dictation paste is not supported on this OS.");
};

const pasteTextIntoFocusedApp = async (text: string) => {
  if (dictationBridgeIsSupported()) {
    const result = await runNativeHelper("dictation_bridge", ["paste", text], {
      timeout: DICTATION_BRIDGE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      onError: (error) => {
        console.debug("[dictation] native paste failed:", error.message);
      },
    });
    if (result) return;
  }

  const previous = readClipboardSnapshot();
  clipboard.writeText(text);
  await sleep(CLIPBOARD_SETTLE_MS);
  await issuePasteKeystroke();
  await sleep(PASTE_SETTLE_MS);
  if (clipboard.readText() === text) {
    restoreClipboardSnapshot(previous);
  }
};

const soundPath = (sound: DictationSound) => {
  const packagedPath = path.join(
    process.resourcesPath,
    "audio",
    `${sound}.mp3`,
  );
  if (process.env.NODE_ENV !== "development") return packagedPath;

  const devCandidates = [
    path.resolve(
      process.cwd(),
      "desktop",
      "resources",
      "audio",
      `${sound}.mp3`,
    ),
    path.resolve(process.cwd(), "resources", "audio", `${sound}.mp3`),
  ];
  return (
    devCandidates.find((candidate) => fs.existsSync(candidate)) ?? packagedPath
  );
};

const playDictationSound = (sound: DictationSound) => {
  if (process.platform !== "darwin") return;
  execFile(
    "/usr/bin/afplay",
    ["-v", DICTATION_SOUND_VOLUME_BY_SOUND[sound], soundPath(sound)],
    (error) => {
      if (error) {
        console.debug("[dictation] sound failed:", error.message);
      }
    },
  );
};

export const registerDictationHandlers = (
  options: DictationHandlersOptions,
) => {
  const { windowManager } = options;
  let currentShortcut = "";
  let activeOverlaySessionId: string | null = null;
  /**
   * When set, the active overlay session's transcript is delivered to
   * Stella's chat (via IPC_PET_SEND_MESSAGE) instead of being pasted
   * into whatever app is in the foreground. Used by the pet's mic
   * action button so a click → dictate → auto-send-to-Stella round-trip
   * lands the spoken text in chat regardless of which app is focused.
   */
  let activeOverlayRoute: "paste" | "stella-chat" = "paste";
  let pendingInAppStartId: string | null = null;
  let activePushToTalk: DictationMode | null = null;
  let mutedOutputVolume: number | null = null;
  let mutedOutputPreviousMuted: boolean | null = null;
  let outputMutePromise: Promise<void> | null = null;
  let outputMuteActive = false;
  let outputMuteDelayTimer: ReturnType<typeof setTimeout> | null = null;
  const activeDictationSources = new Set<string>();
  let dictationActive = false;

  const areDictationSoundsEnabled = () => {
    const stellaRoot = options.getStellaRoot();
    return stellaRoot ? getDictationSoundEffectsEnabled(stellaRoot) : true;
  };

  const playEnabledDictationSound = (sound: DictationSound) => {
    if (!areDictationSoundsEnabled()) return;
    playDictationSound(sound);
  };

  const setDictationSourceActive = (source: string, active: boolean) => {
    const previous = dictationActive;
    if (active) {
      activeDictationSources.add(source);
    } else {
      activeDictationSources.delete(source);
    }
    dictationActive = activeDictationSources.size > 0;
    if (dictationActive !== previous) {
      options.onDictationActiveChanged?.(dictationActive);
    }
  };

  const muteOutputForDictation = () => {
    if (!dictationBridgeIsSupported()) return;
    if (outputMuteDelayTimer) {
      clearTimeout(outputMuteDelayTimer);
      outputMuteDelayTimer = null;
    }
    if (mutedOutputVolume !== null) {
      outputMuteActive = true;
      return;
    }
    outputMuteActive = true;
    if (outputMutePromise) return;
    outputMutePromise = runNativeHelper("dictation_bridge", ["mute-output"], {
      timeout: DICTATION_BRIDGE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      onError: (error) => {
        console.debug("[dictation] output mute failed:", error.message);
      },
    })
      .then((raw) => {
        if (!raw) return;
        const result = JSON.parse(raw) as DictationMuteResult;
        if (result.ok === true && typeof result.previousVolume === "number") {
          mutedOutputVolume = result.previousVolume;
          mutedOutputPreviousMuted =
            typeof result.previousMuted === "boolean"
              ? result.previousMuted
              : null;
          if (!outputMuteActive) {
            restoreOutputAfterDictation();
          }
        }
      })
      .catch((error) => {
        console.debug("[dictation] output mute failed:", error);
      })
      .finally(() => {
        outputMutePromise = null;
      });
  };

  const muteOutputForDictationAfterStartCue = () => {
    if (!dictationBridgeIsSupported()) return;
    outputMuteActive = true;
    if (mutedOutputVolume !== null || outputMutePromise) return;
    if (outputMuteDelayTimer) {
      clearTimeout(outputMuteDelayTimer);
    }
    outputMuteDelayTimer = setTimeout(() => {
      outputMuteDelayTimer = null;
      if (!outputMuteActive) return;
      muteOutputForDictation();
    }, DICTATION_START_SOUND_MUTE_DELAY_MS);
  };

  const restoreOutputAfterDictation = () => {
    if (!dictationBridgeIsSupported()) return;
    if (outputMuteDelayTimer) {
      clearTimeout(outputMuteDelayTimer);
      outputMuteDelayTimer = null;
    }
    outputMuteActive = false;
    const previousVolume = mutedOutputVolume;
    const previousMuted = mutedOutputPreviousMuted;
    mutedOutputVolume = null;
    mutedOutputPreviousMuted = null;
    if (typeof previousVolume !== "number") return;
    const args = ["restore-output", String(previousVolume)];
    if (typeof previousMuted === "boolean") {
      args.push(previousMuted ? "true" : "false");
    }
    runNativeHelper("dictation_bridge", args, {
      timeout: DICTATION_BRIDGE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      onError: (error) => {
        console.debug("[dictation] output restore failed:", error.message);
      },
    }).catch((error) => {
      console.debug("[dictation] output restore failed:", error);
    });
  };

  const pickFocusedStellaWindow = (): BrowserWindow | null => {
    // The mini window is an NSPanel with screen-saver `alwaysOnTop`; on macOS
    // panels can retain key status even after another app becomes the
    // frontmost app, so `BrowserWindow.getFocusedWindow()` alone keeps
    // pointing at the mini composer after the user has switched away. Gate
    // on Stella itself being the active app so dictation while another app
    // is in the foreground routes through the OS-wide overlay instead.
    if (process.platform === "darwin" && !app.isActive()) return null;
    const focused = BrowserWindow.getFocusedWindow();
    if (!isUsableWindow(focused)) return null;
    if (focused === windowManager.getMiniWindow()) return focused;
    if (focused === windowManager.getFullWindow()) return focused;
    return null;
  };

  const broadcastPetDictationActive = (active: boolean) => {
    for (const window of windowManager.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send("pet:dictationActive", active);
    }
  };

  const hideOverlaySession = (sessionId: string) => {
    if (activeOverlaySessionId !== sessionId) return;
    const wasPetRoute = activeOverlayRoute === "stella-chat";
    activeOverlaySessionId = null;
    activeOverlayRoute = "paste";
    setDictationSourceActive(`overlay:${sessionId}`, false);
    restoreOutputAfterDictation();
    options.getOverlayController()?.hideDictation();
    if (wasPetRoute) broadcastPetDictationActive(false);
  };

  const stopOverlaySession = () => {
    const sessionId = activeOverlaySessionId;
    if (!sessionId) return;
    if (activeOverlayRoute === "stella-chat") {
      broadcastPetDictationActive(false);
    }
    options
      .getOverlayController()
      ?.send("dictation:overlayStop", { sessionId });
  };

  const getOverlayDictationPosition = () => {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const workArea = display.workArea;
    return {
      x: workArea.x + Math.round(workArea.width / 2),
      // Anchor sits at pill center (`translate(-50%, -50%)`); tuck tight above the dock.
      y: workArea.y + workArea.height - 24,
    };
  };

  const startOverlaySession = (
    route: "paste" | "stella-chat" = "paste",
    muteTiming: "immediate" | "afterStartCue" = "immediate",
  ) => {
    const overlay = options.getOverlayController();
    if (!overlay) return;

    if (activeOverlaySessionId) {
      stopOverlaySession();
      return;
    }

    const sessionId = randomUUID();
    activeOverlaySessionId = sessionId;
    activeOverlayRoute = route;
    setDictationSourceActive(`overlay:${sessionId}`, true);
    const position = getOverlayDictationPosition();
    overlay.showDictation(position.x, position.y);
    overlay.send("dictation:overlayStart", { sessionId });
    if (muteTiming === "afterStartCue") {
      muteOutputForDictationAfterStartCue();
    } else {
      muteOutputForDictation();
    }
    if (route === "stella-chat") broadcastPetDictationActive(true);
  };

  const revealOverlayPushToTalk = (sessionId: string) => {
    if (activeOverlaySessionId !== sessionId) return;
    const overlay = options.getOverlayController();
    if (!overlay) return;
    const position = getOverlayDictationPosition();
    overlay.showDictation(position.x, position.y);
  };

  const startOverlayPushToTalk = (
    muteTiming: "immediate" | "afterStartCue" = "immediate",
  ): DictationMode | null => {
    const overlay = options.getOverlayController();
    if (!overlay || activeOverlaySessionId) return null;
    const sessionId = randomUUID();
    activeOverlaySessionId = sessionId;
    setDictationSourceActive(`overlay:${sessionId}`, true);
    overlay.send("dictation:overlayStart", { sessionId });
    if (muteTiming === "afterStartCue") {
      muteOutputForDictationAfterStartCue();
    } else {
      muteOutputForDictation();
    }
    return { type: "overlay", sessionId };
  };

  const startPushToTalk = () => {
    if (activePushToTalk || activeOverlaySessionId) return;
    playEnabledDictationSound("startRecording");

    const target = pickFocusedStellaWindow();
    if (target) {
      muteOutputForDictationAfterStartCue();
      const startId = randomUUID();
      pendingInAppStartId = startId;
      activePushToTalk = { type: "in-app", window: target, startId };
      setDictationSourceActive(`in-app:${startId}`, true);
      target.webContents.send("dictation:toggle", {
        startId,
        action: "start",
      });
      setTimeout(() => {
        if (pendingInAppStartId !== startId) return;
        pendingInAppStartId = null;
        if (
          activePushToTalk?.type === "in-app" &&
          activePushToTalk.startId === startId
        ) {
          setDictationSourceActive(`in-app:${startId}`, false);
          activePushToTalk = startOverlayPushToTalk("afterStartCue");
        }
      }, IN_APP_START_ACK_TIMEOUT_MS);
      return;
    }

    activePushToTalk = startOverlayPushToTalk("afterStartCue");
  };

  const revealPushToTalk = () => {
    const active = activePushToTalk;
    if (!active) return;
    if (active.type === "overlay") {
      revealOverlayPushToTalk(active.sessionId);
      return;
    }
    if (active.window.isDestroyed()) return;
    active.window.webContents.send("dictation:toggle", {
      startId: active.startId,
      action: "reveal",
    });
  };

  const stopPushToTalk = (durationMs: number) => {
    const active = activePushToTalk;
    activePushToTalk = null;
    pendingInAppStartId = null;
    if (!active) return;

    if (durationMs < PUSH_TO_TALK_MIN_DURATION_MS) {
      restoreOutputAfterDictation();
      if (active.type === "overlay") {
        options
          .getOverlayController()
          ?.send("dictation:overlayCancel", { sessionId: active.sessionId });
      } else {
        setDictationSourceActive(`in-app:${active.startId}`, false);
        if (active.window.isDestroyed()) return;
        active.window.webContents.send("dictation:toggle", {
          startId: active.startId,
          action: "cancel",
        });
      }
      return;
    }

    restoreOutputAfterDictation();
    playEnabledDictationSound("stopRecording");
    if (active.type === "overlay") {
      options.getOverlayController()?.send("dictation:overlayStop", {
        sessionId: active.sessionId,
      });
      return;
    }
    if (!active.window.isDestroyed()) {
      setDictationSourceActive(`in-app:${active.startId}`, false);
      active.window.webContents.send("dictation:toggle", {
        startId: active.startId,
        action: "stop",
      });
    } else {
      setDictationSourceActive(`in-app:${active.startId}`, false);
    }
  };

  const cancelPushToTalk = () => {
    const active = activePushToTalk;
    activePushToTalk = null;
    pendingInAppStartId = null;
    if (!active) return;
    restoreOutputAfterDictation();
    if (active.type === "overlay") {
      options
        .getOverlayController()
        ?.send("dictation:overlayCancel", { sessionId: active.sessionId });
      return;
    }
    setDictationSourceActive(`in-app:${active.startId}`, false);
    if (!active.window.isDestroyed()) {
      active.window.webContents.send("dictation:toggle", {
        startId: active.startId,
        action: "cancel",
      });
    }
  };

  const discardPushToTalk = () => {
    const active = activePushToTalk;
    activePushToTalk = null;
    pendingInAppStartId = null;
    if (!active) return;
    restoreOutputAfterDictation();
    if (active.type === "overlay") {
      options
        .getOverlayController()
        ?.send("dictation:overlayCancel", { sessionId: active.sessionId });
      return;
    }
    setDictationSourceActive(`in-app:${active.startId}`, false);
    if (!active.window.isDestroyed()) {
      active.window.webContents.send("dictation:toggle", {
        startId: active.startId,
        action: "cancel",
      });
    }
  };

  const toggleDictation = () => {
    if (activeOverlaySessionId) {
      playEnabledDictationSound("stopRecording");
      stopOverlaySession();
      return;
    }

    const target = pickFocusedStellaWindow();
    if (target) {
      const isStopping = activeDictationSources.has(
        `renderer:${target.webContents.id}`,
      );
      const startId = randomUUID();
      pendingInAppStartId = startId;
      playEnabledDictationSound(
        isStopping ? "stopRecording" : "startRecording",
      );
      target.webContents.send("dictation:toggle", { startId });
      setTimeout(() => {
        if (pendingInAppStartId !== startId) return;
        pendingInAppStartId = null;
        startOverlaySession();
      }, IN_APP_START_ACK_TIMEOUT_MS);
      return;
    }

    playEnabledDictationSound("startRecording");
    startOverlaySession("paste", "afterStartCue");
  };

  const applyDictationShortcutRegistration = (
    requestedShortcut: string,
  ): ShortcutRegistrationResult => {
    if (
      currentShortcut &&
      currentShortcut !== PUSH_TO_TALK_DICTATION_SHORTCUT
    ) {
      applyShortcutRegistration({
        label: "Dictation",
        requestedShortcut: "",
        currentShortcut,
        callback: toggleDictation,
        onActiveShortcutChange: (shortcut) => {
          currentShortcut = shortcut;
        },
      });
    }

    if (requestedShortcut === PUSH_TO_TALK_DICTATION_SHORTCUT) {
      currentShortcut = requestedShortcut;
      return {
        ok: true,
        requestedShortcut,
        activeShortcut: requestedShortcut,
      };
    }

    return applyShortcutRegistration({
      label: "Dictation",
      requestedShortcut,
      currentShortcut:
        currentShortcut === PUSH_TO_TALK_DICTATION_SHORTCUT
          ? ""
          : currentShortcut,
      callback: toggleDictation,
      onActiveShortcutChange: (shortcut) => {
        currentShortcut = shortcut;
      },
    });
  };

  const loadConfiguredShortcut = () => {
    const platformDefault =
      process.platform === "darwin"
        ? DEFAULT_DICTATION_SHORTCUT
        : DEFAULT_NON_MAC_DICTATION_SHORTCUT;
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) return platformDefault;
    const shortcut = loadLocalPreferences(stellaRoot).dictationShortcut;
    if (
      process.platform !== "darwin" &&
      shortcut === PUSH_TO_TALK_DICTATION_SHORTCUT
    ) {
      return DEFAULT_NON_MAC_DICTATION_SHORTCUT;
    }
    return shortcut === LEGACY_DEFAULT_DICTATION_SHORTCUT
      ? platformDefault
      : shortcut;
  };

  const saveConfiguredShortcut = (shortcut: string) => {
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) return;
    const prefs = loadLocalPreferences(stellaRoot);
    prefs.dictationShortcut = shortcut;
    saveLocalPreferences(stellaRoot, prefs);
  };

  const initial = applyDictationShortcutRegistration(loadConfiguredShortcut());
  if (!initial.ok) {
    console.warn("[dictation]", initial.error);
  }

  ipcMain.handle("dictation:setShortcut", (_event, shortcut: string) => {
    const result = applyDictationShortcutRegistration(shortcut);
    if (!result.ok) {
      console.warn("[dictation]", result.error);
    } else {
      saveConfiguredShortcut(result.activeShortcut);
    }
    return result;
  });

  ipcMain.handle("dictation:getShortcut", () => currentShortcut);

  ipcMain.handle("dictation:getSoundEffectsEnabled", () =>
    areDictationSoundsEnabled(),
  );

  ipcMain.handle(
    "dictation:setSoundEffectsEnabled",
    (_event, enabled: boolean) => {
      const nextEnabled = enabled === true;
      const stellaRoot = options.getStellaRoot();
      if (stellaRoot) {
        const prefs = loadLocalPreferences(stellaRoot);
        prefs.dictationSoundEffectsEnabled = nextEnabled;
        saveLocalPreferences(stellaRoot, prefs);
      }
      return { enabled: nextEnabled };
    },
  );

  ipcMain.handle("dictation:warmLocal", () => warmLocalParakeet());

  ipcMain.handle("dictation:localStatus", () => getLocalParakeetStatus());

  ipcMain.handle(
    "dictation:transcribeLocal",
    async (
      _event,
      payload: {
        audioBase64?: string;
      } | null,
    ) => {
      const audioBase64 = payload?.audioBase64;
      if (!audioBase64) {
        throw new Error("Missing dictation audio.");
      }
      return transcribeWithLocalParakeet(audioBase64);
    },
  );

  ipcMain.on(
    "dictation:inAppStarted",
    (
      _event,
      payload: {
        startId?: string;
      } | null,
    ) => {
      if (!payload?.startId) return;
      if (pendingInAppStartId === payload.startId) {
        pendingInAppStartId = null;
      }
      setDictationSourceActive(`in-app:${payload.startId}`, false);
    },
  );

  ipcMain.on(
    "dictation:activeChanged",
    (
      event,
      payload: {
        active?: boolean;
      } | null,
    ) => {
      setDictationSourceActive(
        `renderer:${event.sender.id}`,
        payload?.active === true,
      );
    },
  );

  ipcMain.on(
    "dictation:playSound",
    (
      _event,
      payload: {
        sound?: "startRecording" | "stopRecording" | "cancel";
      } | null,
    ) => {
      if (
        payload?.sound !== "startRecording" &&
        payload?.sound !== "stopRecording" &&
        payload?.sound !== "cancel"
      ) {
        return;
      }
      playEnabledDictationSound(payload.sound);
    },
  );

  ipcMain.on(
    "dictation:overlayCompleted",
    (
      _event,
      payload: {
        sessionId: string;
        text: string;
      },
    ) => {
      if (payload.sessionId !== activeOverlaySessionId) return;
      const route = activeOverlayRoute;
      activeOverlayRoute = "paste";
      hideOverlaySession(payload.sessionId);
      const text = payload.text.trim();
      if (!text) return;
      if (route === "stella-chat") {
        // Pet mic flow: deliver transcript to Stella's chat instead of
        // pasting into the foreground app.
        const fullWindow = windowManager.getFullWindow();
        if (fullWindow && !fullWindow.isDestroyed()) {
          fullWindow.webContents.send("pet:sendMessage", text);
        }
        return;
      }
      pasteTextIntoFocusedApp(`${text} `).catch((error) => {
        console.warn("[dictation] OS-wide paste failed:", error);
      });
    },
  );

  ipcMain.on(
    "dictation:overlayFailed",
    (
      _event,
      payload: {
        sessionId: string;
        error?: string;
      },
    ) => {
      if (payload.sessionId !== activeOverlaySessionId) return;
      hideOverlaySession(payload.sessionId);
      console.warn("[dictation] overlay dictation failed:", payload.error);
    },
  );

  /**
   * Start an overlay dictation session whose transcript routes to
   * Stella's chat instead of pasting. Used by the pet's mic action
   * button so a click → speak → auto-send round-trip lands the
   * transcript as a chat message regardless of the foreground app.
   * Toggling while a session is active stops it (same UX as the
   * default overlay session toggle).
   */
  const startPetDictation = () => {
    if (activeOverlaySessionId) {
      stopOverlaySession();
      return;
    }
    startOverlaySession("stella-chat");
  };

  return {
    isEnabled: () =>
      dictationBridgeIsSupported() &&
      currentShortcut === PUSH_TO_TALK_DICTATION_SHORTCUT,
    start: startPushToTalk,
    reveal: revealPushToTalk,
    stop: stopPushToTalk,
    cancel: cancelPushToTalk,
    discard: discardPushToTalk,
    startPetDictation,
  } satisfies DictationPushToTalkController & {
    startPetDictation: () => void;
  };
};
