import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

export type PrivilegedIpcOptions = {
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export function assertPrivilegedRequest(
  options: PrivilegedIpcOptions,
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
) {
  if (!options.assertPrivilegedSender(event, channel)) {
    throw new Error(`Blocked untrusted ${channel} request.`);
  }
}

export function registerPrivilegedHandle<TArgs extends unknown[], TResult>(
  options: PrivilegedIpcOptions,
  channel: string,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: TArgs
  ) => TResult | Promise<TResult>,
) {
  ipcMain.handle(channel, async (event, ...args: TArgs) => {
    assertPrivilegedRequest(options, event, channel);
    return await handler(event, ...args);
  });
}
