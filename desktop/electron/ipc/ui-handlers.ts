import { app, BrowserWindow, ipcMain, screen } from "electron";
import { writeFileSync } from "node:fs";
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
  setAppReady: (ready: boolean) => void;
  deactivateVoiceModes: () => boolean;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
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
    win.close();
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

  // Onboarding presentation expands the main window to cover the current
  // display, then restores the standard centered size on exit.
  const DEFAULT_WIDTH = 1400;
  const DEFAULT_HEIGHT = 940;
  ipcMain.handle(
    "window:setOnboardingPresentation",
    (event, active: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false };
      const display = screen.getDisplayMatching(win.getBounds());
      const work = display.workArea;
      if (active) {
        if (process.platform === "darwin") {
          // We deliberately do NOT use setSimpleFullScreen here: in
          // combination with `transparent: true` + `frame: false`, macOS
          // simple-fullscreen breaks Chromium's hover / cursor hit-testing
          // (clicks still route, but :hover and cursor: pointer never fire).
          // Sizing to the work area gives the fog enough room to feather
          // (it already overscans via CSS) and keeps hover working - the
          // Dock and menu bar stay visible but that's an acceptable trade
          // for an interactive onboarding.
          win.setBounds(work, false);
          win.setWindowButtonVisibility(false);
        } else if (process.platform === "win32") {
          // Work-area bounds rather than setFullScreen: exclusive fullscreen
          // forces a display-topology change and heavier DWM compositing for
          // a surface that only needs to look edge-to-edge.
          win.setBounds(work, false);
        } else {
          win.setBounds(display.bounds, false);
        }
      } else {
        if (process.platform === "darwin") {
          win.setWindowButtonVisibility(true);
        }
        const width = Math.min(DEFAULT_WIDTH, work.width);
        const height = Math.min(DEFAULT_HEIGHT, work.height);
        const x = work.x + Math.round((work.width - width) / 2);
        const y = work.y + Math.round((work.height - height) / 2);
        // `animate: true` is honored on macOS - the window smoothly contracts
        // from the work-area size back to the centered default, in sync with
        // the renderer's fog fade-out. Other platforms just snap.
        win.setBounds({ x, y, width, height }, process.platform === "darwin");
      }
      return { ok: true };
    },
  );

  ipcMain.handle("ui:getState", () => options.uiState);

  ipcMain.handle("ui:setState", (event, partial: Partial<UiState>) => {
    if (!options.assertPrivilegedSender(event, "ui:setState"))
      return options.uiState;
    const {
      isVoiceRtcActive,
      ...rest
    } = partial;
    if (isVoiceRtcActive !== undefined) {
      if (isVoiceRtcActive) {
        options.uiState.isVoiceRtcActive = true;
      } else {
        options.deactivateVoiceModes();
      }
    }
    if (Object.keys(rest).length > 0) {
      options.updateUiState(rest);
    }
    if (isVoiceRtcActive !== undefined) {
      if (isVoiceRtcActive) {
        options.broadcastUiState();
      }
    }
    return options.uiState;
  });

  ipcMain.on("window:show", (event) => {
    if (!options.assertPrivilegedSender(event, "window:show")) return;
    options.windowManager.showWindow();
  });

  ipcMain.on("app:reload", (event) => {
    if (!options.assertPrivilegedSender(event, "app:reload")) return;
    options.windowManager.reloadFullWindow();
  });

  // Used by the static launch splash (`desktop/index.html`) when the renderer
  // has been stuck on the splash long enough that a plain reload is unlikely
  // to help. Packaged builds re-exec Electron; dev builds ask the supervisor
  // to spawn a fresh Electron process without tearing down Vite.
  ipcMain.on("app:relaunch", (event) => {
    if (!options.assertPrivilegedSender(event, "app:relaunch")) return;
    const devRestartRequestFile = process.env.STELLA_DEV_RESTART_REQUEST_FILE;
    if (process.env.NODE_ENV === "development" && devRestartRequestFile) {
      try {
        writeFileSync(devRestartRequestFile, String(Date.now()), "utf8");
      } catch (error) {
        console.error("Failed to request dev relaunch:", error);
      }
      app.quit();
      return;
    }
    app.relaunch();
    app.quit();
  });
};
