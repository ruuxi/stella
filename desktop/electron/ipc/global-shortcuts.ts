import { globalShortcut } from "electron";

type GlobalShortcutModule = {
  setSuspended?: (suspended: boolean) => void;
  isSuspended?: () => boolean;
};

const shortcuts = globalShortcut as unknown as GlobalShortcutModule;

export const setGlobalShortcutsSuspended = (suspended: boolean) => {
  if (!shortcuts.setSuspended || !shortcuts.isSuspended) {
    return {
      supported: false,
      suspended: false,
    };
  }

  shortcuts.setSuspended(suspended);
  return {
    supported: true,
    suspended: shortcuts.isSuspended(),
  };
};

export const getGlobalShortcutsSuspended = () => ({
  supported: Boolean(shortcuts.setSuspended && shortcuts.isSuspended),
  suspended: shortcuts.isSuspended?.() ?? false,
});
