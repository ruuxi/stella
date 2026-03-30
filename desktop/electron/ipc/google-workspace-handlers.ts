import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import {
  IPC_GOOGLE_WORKSPACE_AUTH_STATUS,
  IPC_GOOGLE_WORKSPACE_CONNECT,
  IPC_GOOGLE_WORKSPACE_DISCONNECT,
} from "../../src/shared/contracts/ipc-channels.js";

type GoogleWorkspaceHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export const registerGoogleWorkspaceHandlers = (
  options: GoogleWorkspaceHandlersOptions,
) => {
  const waitForRunner = (timeoutMs = 10_000) =>
    waitForConnectedRunner(options.getStellaHostRunner, {
      timeoutMs,
      unavailableMessage: "Runtime not available.",
      onRunnerChanged: options.onStellaHostRunnerChanged,
    });

  ipcMain.handle(IPC_GOOGLE_WORKSPACE_AUTH_STATUS, async (event) => {
    if (
      !options.assertPrivilegedSender(event, IPC_GOOGLE_WORKSPACE_AUTH_STATUS)
    ) {
      throw new Error("Blocked untrusted googleWorkspace:authStatus request.");
    }
    try {
      return await (await waitForRunner()).googleWorkspaceGetAuthStatus();
    } catch {
      return { connected: false };
    }
  });

  ipcMain.handle(IPC_GOOGLE_WORKSPACE_CONNECT, async (event) => {
    if (
      !options.assertPrivilegedSender(event, IPC_GOOGLE_WORKSPACE_CONNECT)
    ) {
      throw new Error("Blocked untrusted googleWorkspace:connect request.");
    }
    return await (await waitForRunner(130_000)).googleWorkspaceConnect();
  });

  ipcMain.handle(IPC_GOOGLE_WORKSPACE_DISCONNECT, async (event) => {
    if (
      !options.assertPrivilegedSender(event, IPC_GOOGLE_WORKSPACE_DISCONNECT)
    ) {
      throw new Error("Blocked untrusted googleWorkspace:disconnect request.");
    }
    return await (await waitForRunner()).googleWorkspaceDisconnect();
  });
};
