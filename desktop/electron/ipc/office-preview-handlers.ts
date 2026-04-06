import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { IPC_OFFICE_PREVIEW_LIST } from "../../src/shared/contracts/ipc-channels.js";
import { listOfficePreviewSnapshots } from "../bootstrap/office-preview-bridge.js";

type OfficePreviewHandlersOptions = {
  getStellaHomePath: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export const registerOfficePreviewHandlers = (
  options: OfficePreviewHandlersOptions,
) => {
  ipcMain.handle(IPC_OFFICE_PREVIEW_LIST, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_OFFICE_PREVIEW_LIST)) {
      throw new Error("Blocked untrusted office preview request.");
    }

    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath?.trim()) {
      return [];
    }

    return await listOfficePreviewSnapshots(stellaHomePath);
  });
};
