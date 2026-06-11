/**
 * Shared UI state KV IPC — bridges the renderer's durable key/value state
 * (formerly localStorage) to the main-owned `~/.stella/ui-state.json` store.
 *
 * The snapshot channel is synchronous: the preload script reads it once with
 * `ipcRenderer.sendSync` and exposes it as `window.__stellaUiState`, so the
 * boot script and module-load preference reads stay synchronous (no
 * flash-of-wrong-theme).
 */

import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { UiStateStore } from "../../../runtime/kernel/ui-state/store.js";
import {
  sanitizeUiStateChanges,
  type UiStateChanges,
} from "../../../runtime/contracts/ui-state.js";
import {
  IPC_UI_STATE_KV_APPLY,
  IPC_UI_STATE_KV_CHANGED,
  IPC_UI_STATE_KV_CLEAR,
  IPC_UI_STATE_KV_SNAPSHOT,
} from "../../src/shared/contracts/ipc-channels.js";

export type UiStateKvHandlersOptions = {
  stellaDataDirPath: string;
  getAllWindows: () => BrowserWindow[];
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getBroadcastToMobile?: () =>
    | ((channel: string, data: unknown) => void)
    | null;
};

export const registerUiStateKvHandlers = (
  options: UiStateKvHandlersOptions,
): UiStateStore => {
  const store = new UiStateStore(options.stellaDataDirPath);

  const broadcast = (
    changes: UiStateChanges,
    excludeWebContentsId?: number,
  ) => {
    if (Object.keys(changes).length === 0) return;
    for (const window of options.getAllWindows()) {
      if (window.isDestroyed()) continue;
      if (
        excludeWebContentsId != null &&
        window.webContents.id === excludeWebContentsId
      ) {
        continue;
      }
      window.webContents.send(IPC_UI_STATE_KV_CHANGED, changes);
    }
    options.getBroadcastToMobile?.()?.(IPC_UI_STATE_KV_CHANGED, changes);
  };

  ipcMain.on(IPC_UI_STATE_KV_SNAPSHOT, (event) => {
    if (!options.assertPrivilegedSender(event, IPC_UI_STATE_KV_SNAPSHOT)) {
      event.returnValue = {};
      return;
    }
    event.returnValue = store.snapshot();
  });

  ipcMain.on(IPC_UI_STATE_KV_APPLY, (event, rawChanges: unknown) => {
    if (!options.assertPrivilegedSender(event, IPC_UI_STATE_KV_APPLY)) return;
    const changes = sanitizeUiStateChanges(rawChanges);
    if (!changes) return;
    broadcast(store.apply(changes), event.sender.id);
  });

  ipcMain.on(IPC_UI_STATE_KV_CLEAR, (event) => {
    if (!options.assertPrivilegedSender(event, IPC_UI_STATE_KV_CLEAR)) return;
    broadcast(store.clear(), event.sender.id);
  });

  // Changes written by another host on the same file (the Vite dev server's
  // store instance, serving plain-browser tabs) reach every window.
  store.onExternalChange((changes) => broadcast(changes));

  app.on("before-quit", () => {
    store.flushSync();
  });

  return store;
};
