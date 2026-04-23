import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE } from "../../src/shared/contracts/ipc-channels.js";
import type { UiState } from "../types.js";
import type { WindowManager } from "../windows/window-manager.js";

// IPC authorization policy:
//   Privileged (assertPrivilegedSender):  ui:setState, window:show, app:reload, app:setReady
//   Public (read-only, no assertion):     ui:getState, window:isMaximized
//   Window-scoped (operates on sender):   window:minimize, window:maximize, window:close

type UiHandlersOptions = {
  uiState: UiState;
  windowManager: WindowManager;
  updateUiState: (partial: Partial<UiState>) => void;
  broadcastUiState: () => void;
  syncVoiceOverlay: () => void;
  setAppReady: (ready: boolean) => void;
  deactivateVoiceModes: () => boolean;
  syncNativeRadialGesture: () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null;
};

export const registerUiHandlers = (options: UiHandlersOptions) => {
  ipcMain.on("app:setReady", (_event, ready: boolean) => {
    options.setAppReady(!!ready);
  });

  ipcMain.on("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  ipcMain.on("window:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.on("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win === options.windowManager.getMiniWindow()) {
      options.windowManager.hideMiniWindow(true);
      return;
    }
    win.close();
  });

  ipcMain.on("window:restoreSize", () => {
    options.windowManager.showWindow("full");
  });

  ipcMain.handle("window:isMaximized", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized() ?? false;
  });

  ipcMain.on(IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE, (event, visible: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || process.platform !== "darwin") return;
    win.setWindowButtonVisibility(Boolean(visible));
  });

  ipcMain.handle("ui:getState", () => options.uiState);

  ipcMain.handle("ui:setState", (event, partial: Partial<UiState>) => {
    if (!options.assertPrivilegedSender(event, "ui:setState"))
      return options.uiState;
    const previousSuppression =
      options.uiState.suppressNativeRadialDuringOnboarding;
    const {
      window: nextWindow,
      isVoiceRtcActive,
      ...rest
    } = partial;
    if (nextWindow === "mini" || nextWindow === "full") {
      options.windowManager.showWindow(nextWindow);
    }
    if (isVoiceRtcActive !== undefined) {
      options.uiState.isVoiceRtcActive = isVoiceRtcActive;
    }
    if (Object.keys(rest).length > 0) {
      options.updateUiState(rest);
    }
    if (
      partial.suppressNativeRadialDuringOnboarding !== undefined &&
      partial.suppressNativeRadialDuringOnboarding !== previousSuppression
    ) {
      options.syncNativeRadialGesture();
    }
    if (isVoiceRtcActive !== undefined) {
      options.syncVoiceOverlay();
      options.broadcastUiState();
    }
    return options.uiState;
  });

  ipcMain.on("window:show", (event, target: "full" | "mini") => {
    if (!options.assertPrivilegedSender(event, "window:show")) return;
    if (target !== "mini" && target !== "full") {
      return;
    }
    options.windowManager.showWindow(target);
  });

  ipcMain.on(
    "theme:broadcast",
    (event, data: { key: string; value: string }) => {
      const sender = BrowserWindow.fromWebContents(event.sender);
      for (const window of options.windowManager.getAllWindows()) {
        if (window !== sender) {
          window.webContents.send("theme:change", data);
        }
      }
      options.getBroadcastToMobile?.()?.("theme:change", data);
    },
  );

  ipcMain.on("app:reload", (event) => {
    if (!options.assertPrivilegedSender(event, "app:reload")) return;
    options.windowManager.reloadFullWindow();
  });
};
