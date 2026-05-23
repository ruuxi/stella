import { globalShortcut } from "electron";

type GlobalShortcutModule = {
  setSuspended?: (suspended: boolean) => void;
  isSuspended?: () => boolean;
};

const shortcuts = globalShortcut as unknown as GlobalShortcutModule;
let stellaShortcutsSuspended = false;

export const areGlobalShortcutsSuspended = () =>
  stellaShortcutsSuspended || shortcuts.isSuspended?.() === true;

export const setGlobalShortcutsSuspended = (suspended: boolean) => {
  stellaShortcutsSuspended = suspended;

  shortcuts.setSuspended?.(suspended);
  return {
    supported: true,
    suspended: areGlobalShortcutsSuspended(),
  };
};

export const getGlobalShortcutsSuspended = () => ({
  supported: true,
  suspended: areGlobalShortcutsSuspended(),
});
