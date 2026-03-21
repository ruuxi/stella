import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";

type ScheduleHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export const registerScheduleHandlers = (options: ScheduleHandlersOptions) => {
  const waitForRunner = (timeoutMs = 10_000) =>
    waitForConnectedRunner(options.getStellaHostRunner, {
      timeoutMs,
      unavailableMessage: "Runtime not available.",
      onRunnerChanged: options.onStellaHostRunnerChanged,
    });

  ipcMain.handle("schedule:listCronJobs", async (event) => {
    if (!options.assertPrivilegedSender(event, "schedule:listCronJobs")) {
      throw new Error("Blocked untrusted schedule:listCronJobs request.");
    }
    return await (await waitForRunner()).listCronJobs();
  });

  ipcMain.handle("schedule:listHeartbeats", async (event) => {
    if (!options.assertPrivilegedSender(event, "schedule:listHeartbeats")) {
      throw new Error("Blocked untrusted schedule:listHeartbeats request.");
    }
    return await (await waitForRunner()).listHeartbeats();
  });

  ipcMain.handle(
    "schedule:listConversationEvents",
    async (event, payload: { conversationId?: string; maxItems?: number }) => {
      if (
        !options.assertPrivilegedSender(
          event,
          "schedule:listConversationEvents",
        )
      ) {
        throw new Error(
          "Blocked untrusted schedule:listConversationEvents request.",
        );
      }
      const conversationId =
        typeof payload?.conversationId === "string"
          ? payload.conversationId.trim()
          : "";
      if (!conversationId) {
        return [];
      }
      const maxItems = Number(payload?.maxItems);
      return await (await waitForRunner()).listConversationEvents({
        conversationId,
        maxItems: Number.isFinite(maxItems) ? maxItems : undefined,
      });
    },
  );

  ipcMain.handle(
    "schedule:getConversationEventCount",
    async (event, payload: { conversationId?: string }) => {
      if (
        !options.assertPrivilegedSender(
          event,
          "schedule:getConversationEventCount",
        )
      ) {
        throw new Error(
          "Blocked untrusted schedule:getConversationEventCount request.",
        );
      }
      const conversationId =
        typeof payload?.conversationId === "string"
          ? payload.conversationId.trim()
          : "";
      if (!conversationId) {
        return 0;
      }
      return await (await waitForRunner()).getConversationEventCount({ conversationId });
    },
  );
};
