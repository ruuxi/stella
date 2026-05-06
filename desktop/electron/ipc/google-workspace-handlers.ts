import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { registerPrivilegedHandle } from "./privileged-ipc.js";
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

  registerPrivilegedHandle(
    options,
    IPC_GOOGLE_WORKSPACE_AUTH_STATUS,
    async () => {
      try {
        return await (await waitForRunner()).googleWorkspaceGetAuthStatus();
      } catch {
        return { connected: false };
      }
    },
  );

  registerPrivilegedHandle(options, IPC_GOOGLE_WORKSPACE_CONNECT, async () => {
    return await (await waitForRunner(130_000)).googleWorkspaceConnect();
  });

  registerPrivilegedHandle(
    options,
    IPC_GOOGLE_WORKSPACE_DISCONNECT,
    async () => {
      return await (await waitForRunner()).googleWorkspaceDisconnect();
    },
  );
};
