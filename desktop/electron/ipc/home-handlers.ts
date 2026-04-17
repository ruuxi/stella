import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  IPC_HOME_CAPTURE_APP_WINDOW,
  IPC_HOME_GET_ACTIVE_BROWSER_TAB,
  IPC_HOME_LIST_RECENT_APPS,
} from "../../src/shared/contracts/ipc-channels.js";
import { getActiveBrowserTabForBundleId } from "../active-browser-tab.js";
import { captureAppWindow } from "../capture-app-window.js";
import { listRecentApps } from "../recent-apps.js";

type HomeHandlersOptions = {
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const DEFAULT_LIMIT = 6;

export const registerHomeHandlers = (options: HomeHandlersOptions) => {
  ipcMain.handle(
    IPC_HOME_LIST_RECENT_APPS,
    async (event, payload?: { limit?: number }) => {
      if (!options.assertPrivilegedSender(event, IPC_HOME_LIST_RECENT_APPS)) {
        throw new Error(`Blocked untrusted ${IPC_HOME_LIST_RECENT_APPS} request.`);
      }
      const limit = Number(payload?.limit);
      const apps = await listRecentApps(
        Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
      );
      return { apps: apps ?? [] };
    },
  );

  ipcMain.handle(
    IPC_HOME_GET_ACTIVE_BROWSER_TAB,
    async (event, payload?: { bundleId?: string | null }) => {
      if (
        !options.assertPrivilegedSender(event, IPC_HOME_GET_ACTIVE_BROWSER_TAB)
      ) {
        throw new Error(
          `Blocked untrusted ${IPC_HOME_GET_ACTIVE_BROWSER_TAB} request.`,
        );
      }
      const bundleId =
        typeof payload?.bundleId === "string" ? payload.bundleId.trim() : "";
      if (!bundleId) {
        return { tab: null };
      }
      const tab = await getActiveBrowserTabForBundleId(bundleId);
      return { tab };
    },
  );

  ipcMain.handle(
    IPC_HOME_CAPTURE_APP_WINDOW,
    async (
      event,
      payload?: { appName?: string | null; pid?: number | null },
    ) => {
      if (!options.assertPrivilegedSender(event, IPC_HOME_CAPTURE_APP_WINDOW)) {
        throw new Error(
          `Blocked untrusted ${IPC_HOME_CAPTURE_APP_WINDOW} request.`,
        );
      }
      const appName =
        typeof payload?.appName === "string" ? payload.appName.trim() : "";
      const rawPid = payload?.pid;
      const pid =
        typeof rawPid === "number" && Number.isFinite(rawPid) && rawPid > 0
          ? rawPid
          : null;
      if (!appName && !pid) {
        return { capture: null };
      }
      const capture = await captureAppWindow({ appName, pid });
      return { capture };
    },
  );
};
