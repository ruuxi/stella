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

  ipcMain.handle("localChat:createNewDefaultConversationId", async (event) => {
    return await withLocalChatClient(
      options,
      event,
      "localChat:createNewDefaultConversationId",
      (client) => client.createNewDefaultConversationId(),
    );
  });

  ipcMain.handle(
    "localChat:setActiveConversationId",
    async (event, payload: { conversationId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:setActiveConversationId",
        (client) =>
          client.setActiveConversationId(payload?.conversationId ?? ""),
      ),
  );

  ipcMain.handle(
    "localChat:listEvents",
    async (
      event,
      payload: {
        conversationId?: string;
        maxItems?: number;
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
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listMessages",
    async (
      event,
      payload: {
        conversationId?: string;
        maxVisibleMessages?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listMessages",
        (client) =>
          client.listMessages({
            conversationId: payload?.conversationId ?? "",
            maxVisibleMessages: payload?.maxVisibleMessages,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listMessagesBefore",
    async (
      event,
      payload: {
        conversationId?: string;
        beforeTimestampMs?: number;
        beforeId?: string;
        maxVisibleMessages?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listMessagesBefore",
        (client) =>
          client.listMessagesBefore({
            conversationId: payload?.conversationId ?? "",
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : Number.MAX_SAFE_INTEGER,
            beforeId: payload?.beforeId ?? "",
            maxVisibleMessages: payload?.maxVisibleMessages,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listMessagesAfter",
    async (
      event,
      payload: {
        conversationId?: string;
        afterTimestampMs?: number;
        afterId?: string;
        maxVisibleMessages?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listMessagesAfter",
        (client) =>
          client.listMessagesAfter({
            conversationId: payload?.conversationId ?? "",
            afterTimestampMs:
              typeof payload?.afterTimestampMs === "number"
                ? payload.afterTimestampMs
                : 0,
            afterId: payload?.afterId ?? "",
            maxVisibleMessages: payload?.maxVisibleMessages,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listActivity",
    async (
      event,
      payload: {
        conversationId?: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listActivity",
        (client) =>
          client.listActivity({
            conversationId: payload?.conversationId ?? "",
            limit: payload?.limit,
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : undefined,
            beforeId: payload?.beforeId,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listThreadActivity",
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listThreadActivity",
        (client) =>
          client.listThreadActivity({
            conversationId: payload?.conversationId ?? "",
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listFiles",
    async (
      event,
      payload: {
        conversationId?: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listFiles",
        (client) =>
          client.listFiles({
            conversationId: payload?.conversationId ?? "",
            limit: payload?.limit,
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : undefined,
            beforeId: payload?.beforeId,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:getEventCount",
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:getEventCount",
        (client) =>
          client.getEventCount({
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
        firstReport?: unknown;
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
            firstReport: payload?.firstReport,
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
        includeDeveloperArtifacts?: boolean;
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
            includeDeveloperArtifacts:
              payload?.includeDeveloperArtifacts === true,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:syncMessages",
    async (
      event,
      payload: {
        conversationId?: string;
        sinceCursor?: string | null;
        maxMessages?: number;
        includeDeveloperArtifacts?: boolean;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:syncMessages",
        (client) =>
          client.syncMessages({
            conversationId: payload?.conversationId ?? "",
            sinceCursor: payload?.sinceCursor,
            maxMessages: payload?.maxMessages,
            includeDeveloperArtifacts:
              payload?.includeDeveloperArtifacts === true,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:publishReasoningSummaries",
    async (
      event,
      payload: {
        summariesByAgentId?: Record<string, readonly string[]>;
        entriesByAgentId?: Record<
          string,
          readonly { text: string; atMs: number }[]
        >;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:publishReasoningSummaries",
        (client) =>
          client.setReasoningSummaries({
            summariesByAgentId: payload?.summariesByAgentId ?? {},
            ...(payload?.entriesByAgentId
              ? { entriesByAgentId: payload.entriesByAgentId }
              : {}),
          }),
      ),
  );

  ipcMain.handle(
    "localChat:publishTaskDecoration",
    async (
      event,
      payload: {
        statusTextByAgentId?: Record<string, string>;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:publishTaskDecoration",
        (client) =>
          client.setTaskDecoration({
            statusTextByAgentId: payload?.statusTextByAgentId ?? {},
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
