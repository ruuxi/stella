import { app, BrowserWindow, ipcMain, screen } from "electron";
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

  ipcMain.handle("window:isMaximized", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized() ?? false;
  });

  ipcMain.handle("window:isMiniAlwaysOnTop", () =>
    options.windowManager.isMiniAlwaysOnTop(),
  );

  ipcMain.handle("window:setMiniAlwaysOnTop", (event, enabled: boolean) => {
    if (!options.assertPrivilegedSender(event, "window:setMiniAlwaysOnTop")) {
      return options.windowManager.isMiniAlwaysOnTop();
    }
    options.windowManager.setMiniAlwaysOnTop(Boolean(enabled));
    return options.windowManager.isMiniAlwaysOnTop();
  });

  ipcMain.on(IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE, (event, visible: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || process.platform !== "darwin") return;
    win.setWindowButtonVisibility(Boolean(visible));
  });

  // Onboarding presentation: while onboarding is active we expand the
  // (transparent + frameless) main window to cover the current display so
  // the renderer's radial fog mask has room to fade fully to transparent
  // well inside the window bounds - the user can't perceive a window
  // rectangle, only the floating fog. Exit restores the standard size,
  // re-centered on the same display.
  const DEFAULT_WIDTH = 1400;
  const DEFAULT_HEIGHT = 940;
  ipcMain.handle(
    "window:setOnboardingPresentation",
    (event, active: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false };
      // Onboarding presentation only applies to the full window. The mini
      // renderer also mounts FullShell and historically drove this IPC,
      // which animated the mini toward the work-area centre clamped by its
      // max bounds — visible as a creep/grow after first summon.
      if (win === options.windowManager.getMiniWindow()) {
        return { ok: false };
      }
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
          if (!win.isFullScreen()) win.setFullScreen(true);
        } else {
          win.setBounds(display.bounds, false);
        }
      } else {
        if (process.platform === "darwin") {
          win.setWindowButtonVisibility(true);
        } else if (process.platform === "win32") {
          if (win.isFullScreen()) win.setFullScreen(false);
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
      if (isVoiceRtcActive) {
        options.uiState.isVoiceRtcActive = true;
      } else {
        options.deactivateVoiceModes();
      }
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
      if (isVoiceRtcActive) {
        options.broadcastUiState();
      }
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

  // Used by the static launch splash (`desktop/index.html`) when the renderer
  // has been stuck on the splash long enough that a plain reload is unlikely
  // to help — re-exec the Electron process entirely. The detached runtime
  // worker survives this restart, so in-flight runs are not lost.
  ipcMain.on("app:relaunch", (event) => {
    if (!options.assertPrivilegedSender(event, "app:relaunch")) return;
    app.relaunch();
    app.exit(0);
  });
};
