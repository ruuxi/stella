import { globalShortcut } from "electron";

export type ShortcutRegistrationResult = {
  ok: boolean;
  requestedShortcut: string;
  activeShortcut: string;
  error?: string;
};

type ApplyShortcutRegistrationOptions = {
  label: string;
  requestedShortcut: string;
  currentShortcut: string;
  callback: () => void;
  onActiveShortcutChange?: (shortcut: string) => void;
};

export const applyShortcutRegistration = ({
  label,
  requestedShortcut,
  currentShortcut,
  callback,
  onActiveShortcutChange,
}: ApplyShortcutRegistrationOptions): ShortcutRegistrationResult => {
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
    onActiveShortcutChange?.("");
    return {
      ok: true,
      requestedShortcut,
      activeShortcut: "",
    };
  }

  let registrationError: string | undefined;
  try {
    const registered = globalShortcut.register(requestedShortcut, callback);
    if (registered) {
      onActiveShortcutChange?.(requestedShortcut);
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
      if (globalShortcut.register(currentShortcut, callback)) {
        restoredShortcut = currentShortcut;
      }
    } catch {
      restoredShortcut = "";
    }
  }

  onActiveShortcutChange?.(restoredShortcut);

  return {
    ok: false,
    requestedShortcut,
    activeShortcut: restoredShortcut,
    error: restoredShortcut
      ? `${registrationError} Kept "${restoredShortcut}" active instead.`
      : `${registrationError} No fallback shortcut is active.`,
  };
};
