import {
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { ChatContext } from "../../src/shared/contracts/boundary.js";
import type { CaptureService } from "../services/capture-service.js";
import type { RegionSelection } from "../types.js";
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
      return options.captureService.captureScreenshot(point);
    },
  );

  ipcMain.handle(
    "screenshot:captureVision",
    async (event, point?: { x: number; y: number }) => {
      if (!options.assertPrivilegedSender(event, "screenshot:captureVision")) {
        throw new Error("Blocked untrusted request.");
      }
      return options.captureService.captureVisionScreenshot(point);
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
};
