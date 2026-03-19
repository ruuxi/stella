import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { ChatStore } from "../storage/chat-store.js";

type LocalChatHandlersOptions = {
  getChatStore: () => ChatStore | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null;
};

const getChatStore = (options: LocalChatHandlersOptions) => {
  const chatStore = options.getChatStore();
  if (!chatStore) {
    throw new Error("Chat store not available.");
  }
  return chatStore;
};

export const registerLocalChatHandlers = (
  options: LocalChatHandlersOptions,
) => {
  const broadcastUpdated = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("localChat:updated");
      }
    }
    options.getBroadcastToMobile?.()?.("localChat:updated", null);
  };

  ipcMain.handle("localChat:getOrCreateDefaultConversationId", (event) => {
    if (
      !options.assertPrivilegedSender(
        event,
        "localChat:getOrCreateDefaultConversationId",
      )
    ) {
      throw new Error(
        "Blocked untrusted localChat:getOrCreateDefaultConversationId request.",
      );
    }
    return getChatStore(options).getOrCreateDefaultConversationId();
  });

  ipcMain.handle(
    "localChat:listEvents",
    (
      event,
      payload: {
        conversationId?: string;
        maxItems?: number;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "localChat:listEvents")) {
        throw new Error("Blocked untrusted localChat:listEvents request.");
      }
      return getChatStore(options).listEvents(
        payload?.conversationId ?? "",
        payload?.maxItems,
      );
    },
  );

  ipcMain.handle(
    "localChat:getEventCount",
    (
      event,
      payload: {
        conversationId?: string;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "localChat:getEventCount")) {
        throw new Error("Blocked untrusted localChat:getEventCount request.");
      }
      return getChatStore(options).getEventCount(payload?.conversationId ?? "");
    },
  );

  ipcMain.handle(
    "localChat:appendEvent",
    (
      event,
      payload: {
        conversationId?: string;
        type?: string;
        payload?: unknown;
        deviceId?: string;
        requestId?: string;
        targetDeviceId?: string;
        channelEnvelope?: unknown;
        timestamp?: number;
        eventId?: string;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "localChat:appendEvent")) {
        throw new Error("Blocked untrusted localChat:appendEvent request.");
      }
      const result = getChatStore(options).appendEvent({
        conversationId: payload?.conversationId ?? "",
        type: payload?.type ?? "",
        payload: payload?.payload,
        deviceId: payload?.deviceId,
        requestId: payload?.requestId,
        targetDeviceId: payload?.targetDeviceId,
        channelEnvelope: payload?.channelEnvelope,
        timestamp: payload?.timestamp,
        eventId: payload?.eventId,
      });
      broadcastUpdated();
      return result;
    },
  );

  ipcMain.handle(
    "localChat:listSyncMessages",
    (
      event,
      payload: {
        conversationId?: string;
        maxMessages?: number;
      },
    ) => {
      if (
        !options.assertPrivilegedSender(event, "localChat:listSyncMessages")
      ) {
        throw new Error(
          "Blocked untrusted localChat:listSyncMessages request.",
        );
      }
      return getChatStore(options).listSyncMessages(
        payload?.conversationId ?? "",
        payload?.maxMessages,
      );
    },
  );

  ipcMain.handle(
    "localChat:getSyncCheckpoint",
    (
      event,
      payload: {
        conversationId?: string;
      },
    ) => {
      if (
        !options.assertPrivilegedSender(event, "localChat:getSyncCheckpoint")
      ) {
        throw new Error(
          "Blocked untrusted localChat:getSyncCheckpoint request.",
        );
      }
      return getChatStore(options).getSyncCheckpoint(
        payload?.conversationId ?? "",
      );
    },
  );

  ipcMain.handle(
    "localChat:setSyncCheckpoint",
    (
      event,
      payload: {
        conversationId?: string;
        localMessageId?: string;
      },
    ) => {
      if (
        !options.assertPrivilegedSender(event, "localChat:setSyncCheckpoint")
      ) {
        throw new Error(
          "Blocked untrusted localChat:setSyncCheckpoint request.",
        );
      }
      getChatStore(options).setSyncCheckpoint(
        payload?.conversationId ?? "",
        payload?.localMessageId ?? "",
      );
      return { ok: true };
    },
  );
};
