/**
 * Dictation IPC handlers.
 *
 * Owns the global Cmd/Ctrl+Shift+M shortcut for speech-to-text dictation.
 * Focused Stella windows get the in-app composer path; otherwise dictation
 * happens in the shared overlay and the transcript is pasted back into the
 * previously focused app.
 */
import {
  BrowserWindow,
  clipboard,
  ipcMain,
  screen,
  systemPreferences,
} from "electron";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowManager } from "../windows/window-manager.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import {
  loadLocalPreferences,
  saveLocalPreferences,
} from "../../../runtime/kernel/preferences/local-preferences.js";
import {
  applyShortcutRegistration,
  type ShortcutRegistrationResult,
} from "./shortcut-registration.js";

const DEFAULT_DICTATION_SHORTCUT = "Control+M";
const CLIPBOARD_SETTLE_MS = 150;
const PASTE_SETTLE_MS = 700;
const IN_APP_START_ACK_TIMEOUT_MS = 150;

const execFileAsync = promisify(execFile);

type DictationHandlersOptions = {
  windowManager: WindowManager;
  getOverlayController: () => OverlayWindowController | null;
  getStellaRoot: () => string | null;
};

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
      throw new Error("Accessibility permission is required to paste dictation.");
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
  const previous = readClipboardSnapshot();
  clipboard.writeText(text);
  await sleep(CLIPBOARD_SETTLE_MS);
  await issuePasteKeystroke();
  await sleep(PASTE_SETTLE_MS);
  if (clipboard.readText() === text) {
    restoreClipboardSnapshot(previous);
  }
};

export const registerDictationHandlers = (options: DictationHandlersOptions) => {
  const { windowManager } = options;
  let currentShortcut = "";
  let activeOverlaySessionId: string | null = null;
  let pendingInAppStartId: string | null = null;

  const pickFocusedStellaWindow = (): BrowserWindow | null => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!isUsableWindow(focused)) return null;
    if (focused === windowManager.getMiniWindow()) return focused;
    if (focused === windowManager.getFullWindow()) return focused;
    return null;
  };

  const hideOverlaySession = (sessionId: string) => {
    if (activeOverlaySessionId !== sessionId) return;
    activeOverlaySessionId = null;
    options.getOverlayController()?.hideDictation();
  };

  const stopOverlaySession = () => {
    const sessionId = activeOverlaySessionId;
    if (!sessionId) return;
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
      y: workArea.y + workArea.height - 88,
    };
  };

  const startOverlaySession = () => {
    const overlay = options.getOverlayController();
    if (!overlay) return;

    if (activeOverlaySessionId) {
      stopOverlaySession();
      return;
    }

    const sessionId = randomUUID();
    activeOverlaySessionId = sessionId;
    const position = getOverlayDictationPosition();
    overlay.showDictation(position.x, position.y);
    overlay.send("dictation:overlayStart", { sessionId });
  };

  const toggleDictation = () => {
    if (activeOverlaySessionId) {
      stopOverlaySession();
      return;
    }

    const target = pickFocusedStellaWindow();
    if (target) {
      const startId = randomUUID();
      pendingInAppStartId = startId;
      target.webContents.send("dictation:toggle", { startId });
      setTimeout(() => {
        if (pendingInAppStartId !== startId) return;
        pendingInAppStartId = null;
        startOverlaySession();
      }, IN_APP_START_ACK_TIMEOUT_MS);
      return;
    }

    startOverlaySession();
  };

  const applyDictationShortcutRegistration = (
    requestedShortcut: string,
  ): ShortcutRegistrationResult => {
    return applyShortcutRegistration({
      label: "Dictation",
      requestedShortcut,
      currentShortcut,
      callback: toggleDictation,
      onActiveShortcutChange: (shortcut) => {
        currentShortcut = shortcut;
      },
    });
  };

  const loadConfiguredShortcut = () => {
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) return DEFAULT_DICTATION_SHORTCUT;
    return loadLocalPreferences(stellaRoot).dictationShortcut;
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

  ipcMain.handle("dictation:trigger", () => {
    toggleDictation();
    return { ok: true };
  });

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
      hideOverlaySession(payload.sessionId);
      const text = payload.text.trim();
      if (!text) return;
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
};
