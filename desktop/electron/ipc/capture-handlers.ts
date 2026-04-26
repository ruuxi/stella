import {
  BrowserWindow,
  ipcMain,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { ChatContext } from "../../src/shared/contracts/boundary.js";
import type { CaptureService } from "../services/capture-service.js";
import type { RegionSelection } from "../types.js";
import {
  hasMacPermission,
  requestMacPermission,
} from "../utils/macos-permissions.js";
import type { WindowManager } from "../windows/window-manager.js";

type CaptureHandlersOptions = {
  captureService: CaptureService;
  windowManager: WindowManager;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export const registerCaptureHandlers = (options: CaptureHandlersOptions) => {
  const ensureScreenCapturePermission = async () => {
    if (process.platform !== "darwin") {
      return true;
    }
    if (hasMacPermission("screen", false)) {
      return true;
    }
    const result = await requestMacPermission("screen");
    if (result.granted) {
      return true;
    }
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    return false;
  };

  ipcMain.handle("chatContext:get", () =>
    options.captureService.getChatContextSnapshot(),
  );

  ipcMain.on("chatContext:set", (_event, context: ChatContext | null) => {
    options.captureService.setPendingChatContext(context ?? null);
    options.captureService.broadcastChatContext();
  });

  ipcMain.on("chatContext:removeScreenshot", (_event, index: number) => {
    options.captureService.removeScreenshot(index);
    options.captureService.broadcastChatContext();
  });

  ipcMain.on("region:select", (_event, selection: RegionSelection) => {
    void options.captureService.finalizeRegionCapture(selection);
  });

  ipcMain.on("region:cancel", () => {
    options.captureService.cancelRegionCapture();
  });

  ipcMain.handle(
    "region:getWindowCapture",
    async (_event, point: { x: number; y: number }) => {
      if (!(await ensureScreenCapturePermission())) {
        return null;
      }
      return options.captureService.getRegionWindowCapture(point);
    },
  );

  ipcMain.on(
    "region:click",
    async (_event, point: { x: number; y: number }) => {
      await options.captureService.handleRegionClick(point);
    },
  );

  ipcMain.handle(
    "screenshot:capture",
    async (event, point?: { x: number; y: number }) => {
      if (!options.assertPrivilegedSender(event, "screenshot:capture")) {
        throw new Error("Blocked untrusted request.");
      }
      if (!(await ensureScreenCapturePermission())) {
        return null;
      }
      return options.captureService.captureScreenshot(point);
    },
  );

  ipcMain.handle(
    "screenshot:captureVision",
    async (event, point?: { x: number; y: number }) => {
      if (!options.assertPrivilegedSender(event, "screenshot:captureVision")) {
        throw new Error("Blocked untrusted request.");
      }
      if (!(await ensureScreenCapturePermission())) {
        return [];
      }
      return options.captureService.captureVisionScreenshots(point);
    },
  );

  ipcMain.handle("capture:cursorDisplayInfo", () => {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    return {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor ?? 1,
    };
  });

  ipcMain.handle("capture:pageDataUrl", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const image = await win.webContents.capturePage();
    return image.toDataURL();
  });

  // Composer "+ menu" entry point. Mirrors the radial dial's "capture" wedge:
  // minimize the active window, run the region overlay (click=window,
  // drag=region), merge the result into chatContext, then restore the
  // window. Returns synchronously when the user cancels (Esc / right-click).
  ipcMain.handle("capture:beginRegionCapture", async (event) => {
    if (!options.assertPrivilegedSender(event, "capture:beginRegionCapture")) {
      throw new Error("Blocked untrusted request.");
    }
    if (!(await ensureScreenCapturePermission())) {
      return { cancelled: true } as const;
    }

    const wm = options.windowManager;
    const targetWindowMode = wm.getLastActiveWindowMode();
    wm.minimizeWindow();

    const result = await options.captureService.startRegionCapture();

    if (result && (result.screenshot || result.window)) {
      const ctx =
        options.captureService.getChatContextSnapshot()
        ?? options.captureService.emptyContext();
      const existing = ctx.regionScreenshots ?? [];
      const nextScreenshots = result.screenshot
        ? [...existing, result.screenshot]
        : existing;
      const nextWindow = result.window ?? ctx.window;
      options.captureService.setPendingChatContext({
        ...ctx,
        window: nextWindow,
        windowContextEnabled: result.window
          ? false
          : ctx.windowContextEnabled,
        regionScreenshots: nextScreenshots,
      });
      options.captureService.broadcastChatContext();
    }

    // Cancel resolves null; leave the window minimized to match the radial
    // path (the user explicitly bailed, no need to pop the window back).
    if (result !== null) {
      wm.showWindow(targetWindowMode);
    }

    return result === null
      ? ({ cancelled: true } as const)
      : ({ ok: true } as const);
  });
};
