import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

type LocalChatHandlersOptions = {
  localChatHistoryService: LocalChatHistoryService;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const withLocalChatClient = async <T>(
  options: LocalChatHandlersOptions,
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
  action: (client: LocalChatHistoryService) => T | Promise<T>,
) => {
  assertPrivilegedRequest(options, event, channel);
  return await action(options.localChatHistoryService);
};

export const registerLocalChatHandlers = (
  options: LocalChatHandlersOptions,
) => {
  ipcMain.handle(
    "localChat:getOrCreateDefaultConversationId",
    async (event) => {
      return await withLocalChatClient(
        options,
        event,
        "localChat:getOrCreateDefaultConversationId",
        (client) => client.getOrCreateDefaultConversationId(),
      );
    },
  );

  ipcMain.handle(
    "localChat:listEvents",
    async (
      event,
      payload: {
        conversationId?: string;
        maxItems?: number;
        windowBy?: "events" | "visible_messages";
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listEvents",
        (client) =>
          client.listEvents({
            conversationId: payload?.conversationId ?? "",
            maxItems: payload?.maxItems,
            windowBy: payload?.windowBy,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listEventsBefore",
    async (
      event,
      payload: {
        conversationId?: string;
        beforeTimestampMs?: number;
        beforeId?: string;
        limit?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listEventsBefore",
        (client) =>
          client.listEventsBefore({
            conversationId: payload?.conversationId ?? "",
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : Number.MAX_SAFE_INTEGER,
            beforeId: payload?.beforeId,
            limit: payload?.limit,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:getEventCount",
    async (
      event,
      payload: {
        conversationId?: string;
        countBy?: "events" | "visible_messages";
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:getEventCount",
        (client) =>
          client.getEventCount({
            conversationId: payload?.conversationId ?? "",
            countBy: payload?.countBy,
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
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:persistDiscoveryWelcome",
        (client) =>
          client.persistDiscoveryWelcome({
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
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listSyncMessages",
        (client) =>
          client.listSyncMessages({
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
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:getSyncCheckpoint",
        (client) =>
          client.getSyncCheckpoint({
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
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:setSyncCheckpoint",
        (client) =>
          client.setSyncCheckpoint({
            conversationId: payload?.conversationId ?? "",
            localMessageId: payload?.localMessageId ?? "",
          }),
      ),
  );
};
