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

export const registerLocalChatHandlers = (
  options: LocalChatHandlersOptions,
) => {
  ipcMain.handle("localChat:getOrCreateDefaultConversationId", async (event) => {
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
    return await (await waitForRunner(options)).client.getOrCreateDefaultConversationId();
  });

  ipcMain.handle(
    "localChat:listEvents",
    async (
      event,
      payload: {
        conversationId?: string;
        maxItems?: number;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "localChat:listEvents")) {
        throw new Error("Blocked untrusted localChat:listEvents request.");
      }
      return await (await waitForRunner(options)).client.listLocalChatEvents({
        conversationId: payload?.conversationId ?? "",
        maxItems: payload?.maxItems,
      });
    },
  );

  ipcMain.handle(
    "localChat:getEventCount",
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "localChat:getEventCount")) {
        throw new Error("Blocked untrusted localChat:getEventCount request.");
      }
      return await (await waitForRunner(options)).client.getLocalChatEventCount({
        conversationId: payload?.conversationId ?? "",
      });
    },
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
    ) => {
      if (
        !options.assertPrivilegedSender(
          event,
          "localChat:persistDiscoveryWelcome",
        )
      ) {
        throw new Error(
          "Blocked untrusted localChat:persistDiscoveryWelcome request.",
        );
      }
      return await (await waitForRunner(options)).client.persistDiscoveryWelcome({
        conversationId: payload?.conversationId ?? "",
        message: payload?.message ?? "",
        suggestions: payload?.suggestions,
      });
    },
  );

  ipcMain.handle(
    "localChat:listSyncMessages",
    async (
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
      return await (await waitForRunner(options)).client.listLocalChatSyncMessages({
        conversationId: payload?.conversationId ?? "",
        maxMessages: payload?.maxMessages,
      });
    },
  );

  ipcMain.handle(
    "localChat:getSyncCheckpoint",
    async (
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
      return await (await waitForRunner(options)).client.getLocalChatSyncCheckpoint({
        conversationId: payload?.conversationId ?? "",
      });
    },
  );

  ipcMain.handle(
    "localChat:setSyncCheckpoint",
    async (
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
      return await (await waitForRunner(options)).client.setLocalChatSyncCheckpoint({
        conversationId: payload?.conversationId ?? "",
        localMessageId: payload?.localMessageId ?? "",
      });
    },
  );
};
