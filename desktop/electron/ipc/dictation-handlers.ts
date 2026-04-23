/**
 * Dictation IPC handlers.
 *
 * Owns the global Cmd/Ctrl+Shift+M shortcut that toggles speech-to-text
 * dictation into the focused composer. Sends a single
 * `dictation:toggle` event to the focused Stella window; if no Stella
 * window is focused, surfaces and focuses the most appropriate one
 * (mini if it's already showing, otherwise the full window) before
 * forwarding the toggle.
 */
import { BrowserWindow, globalShortcut, ipcMain } from "electron";
import type { WindowManager } from "../windows/window-manager.js";

const DEFAULT_DICTATION_SHORTCUT = "CommandOrControl+Shift+M";

type ShortcutRegistrationResult = {
  ok: boolean;
  requestedShortcut: string;
  activeShortcut: string;
  error?: string;
};

type DictationHandlersOptions = {
  windowManager: WindowManager;
};

const isUsableWindow = (
  window: BrowserWindow | null,
): window is BrowserWindow => Boolean(window && !window.isDestroyed());

export const registerDictationHandlers = (options: DictationHandlersOptions) => {
  const { windowManager } = options;
  let currentShortcut = "";

  const pickTargetWindow = (): BrowserWindow | null => {
    const focused = BrowserWindow.getFocusedWindow();
    if (isUsableWindow(focused)) return focused;

    const mini = windowManager.getMiniWindow();
    if (isUsableWindow(mini) && mini.isVisible()) return mini;

    const full = windowManager.getFullWindow();
    if (isUsableWindow(full)) return full;

    return null;
  };

  const toggleDictation = () => {
    const target = pickTargetWindow();
    if (!target) return;
    if (!target.isFocused()) {
      target.show();
      target.focus();
    }
    target.webContents.send("dictation:toggle");
  };

  const applyShortcutRegistration = (
    requestedShortcut: string,
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
      currentShortcut = "";
      return {
        ok: true,
        requestedShortcut,
        activeShortcut: "",
      };
    }

    let registrationError: string | undefined;
    try {
      const registered = globalShortcut.register(
        requestedShortcut,
        toggleDictation,
      );
      if (registered) {
        currentShortcut = requestedShortcut;
        return {
          ok: true,
          requestedShortcut,
          activeShortcut: requestedShortcut,
        };
      }
      registrationError = `Dictation shortcut "${requestedShortcut}" is unavailable.`;
    } catch (error) {
      registrationError =
        error instanceof Error
          ? error.message
          : `Dictation shortcut "${requestedShortcut}" is unavailable.`;
    }

    let restoredShortcut = "";
    if (currentShortcut) {
      try {
        if (globalShortcut.register(currentShortcut, toggleDictation)) {
          restoredShortcut = currentShortcut;
        } else {
          currentShortcut = "";
        }
      } catch {
        currentShortcut = "";
      }
    }
    if (!restoredShortcut) {
      currentShortcut = "";
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

  const initial = applyShortcutRegistration(DEFAULT_DICTATION_SHORTCUT);
  if (!initial.ok) {
    console.warn("[dictation]", initial.error);
  }

  ipcMain.handle("dictation:setShortcut", (_event, shortcut: string) => {
    const result = applyShortcutRegistration(shortcut);
    if (!result.ok) {
      console.warn("[dictation]", result.error);
    }
    return result;
  });

  ipcMain.handle("dictation:getShortcut", () => currentShortcut);

  ipcMain.handle("dictation:trigger", () => {
    toggleDictation();
    return { ok: true };
  });
};
