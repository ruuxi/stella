import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";

type LocalChatHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null;
};

const waitForRunner = async (
  options: LocalChatHandlersOptions,
  timeoutMs = 10_000,
) =>
  waitForConnectedRunner(options.getStellaHostRunner, {
    timeoutMs,
    unavailableMessage: "Runtime not available.",
    onRunnerChanged: options.onStellaHostRunnerChanged,
  });

const assertPrivilegedRequest = (
  options: LocalChatHandlersOptions,
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
) => {
  if (!options.assertPrivilegedSender(event, channel)) {
    throw new Error(`Blocked untrusted ${channel} request.`);
  }
};

const withLocalChatClient = async <T>(
  options: LocalChatHandlersOptions,
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
  action: (
    client: Awaited<ReturnType<typeof waitForRunner>>["client"],
  ) => Promise<T>,
) => {
  assertPrivilegedRequest(options, event, channel);
  return await action((await waitForRunner(options)).client);
};

export const registerLocalChatHandlers = (
  options: LocalChatHandlersOptions,
) => {
  ipcMain.handle("localChat:getOrCreateDefaultConversationId", async (event) => {
    return await withLocalChatClient(
      options,
      event,
      "localChat:getOrCreateDefaultConversationId",
      (client) => client.getOrCreateDefaultConversationId(),
    );
  });

  ipcMain.handle(
    "localChat:listEvents",
    async (
      event,
      payload: {
        conversationId?: string;
        maxItems?: number;
      },
    ) => await withLocalChatClient(options, event, "localChat:listEvents", (client) =>
      client.listLocalChatEvents({
        conversationId: payload?.conversationId ?? "",
        maxItems: payload?.maxItems,
      })),
  );

  ipcMain.handle(
    "localChat:getEventCount",
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) => await withLocalChatClient(
      options,
      event,
      "localChat:getEventCount",
      (client) => client.getLocalChatEventCount({
        conversationId: payload?.conversationId ?? "",
      }),
    ),
  );

  ipcMain.handle(
    "localChat:persistDiscoveryWelcome",
    async (
      event,
      payload: {
        conversationId?: string;
        message?: string;
        suggestions?: unknown[];
      },
    ) => await withLocalChatClient(
      options,
      event,
      "localChat:persistDiscoveryWelcome",
      (client) => client.persistDiscoveryWelcome({
        conversationId: payload?.conversationId ?? "",
        message: payload?.message ?? "",
        suggestions: payload?.suggestions,
      }),
    ),
  );

  ipcMain.handle(
    "localChat:listSyncMessages",
    async (
      event,
      payload: {
        conversationId?: string;
        maxMessages?: number;
      },
    ) => await withLocalChatClient(
      options,
      event,
      "localChat:listSyncMessages",
      (client) => client.listLocalChatSyncMessages({
        conversationId: payload?.conversationId ?? "",
        maxMessages: payload?.maxMessages,
      }),
    ),
  );

  ipcMain.handle(
    "localChat:getSyncCheckpoint",
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) => await withLocalChatClient(
      options,
      event,
      "localChat:getSyncCheckpoint",
      (client) => client.getLocalChatSyncCheckpoint({
        conversationId: payload?.conversationId ?? "",
      }),
    ),
  );

  ipcMain.handle(
    "localChat:setSyncCheckpoint",
    async (
      event,
      payload: {
        conversationId?: string;
        localMessageId?: string;
      },
    ) => await withLocalChatClient(
      options,
      event,
      "localChat:setSyncCheckpoint",
      (client) => client.setLocalChatSyncCheckpoint({
        conversationId: payload?.conversationId ?? "",
        localMessageId: payload?.localMessageId ?? "",
      }),
    ),
  );
};
