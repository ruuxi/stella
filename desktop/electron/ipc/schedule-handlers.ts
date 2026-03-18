import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { LocalSchedulerService } from "../services/local-scheduler-service.js";

type ScheduleHandlersOptions = {
  schedulerService: LocalSchedulerService;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export const registerScheduleHandlers = (options: ScheduleHandlersOptions) => {
  const broadcastUpdate = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("schedule:updated");
      }
    }
  };

  options.schedulerService.subscribe(() => {
    broadcastUpdate();
  });

  ipcMain.handle("schedule:listCronJobs", (event) => {
    if (!options.assertPrivilegedSender(event, "schedule:listCronJobs")) {
      throw new Error("Blocked untrusted schedule:listCronJobs request.");
    }
    return options.schedulerService.listCronJobs();
  });

  ipcMain.handle("schedule:listHeartbeats", (event) => {
    if (!options.assertPrivilegedSender(event, "schedule:listHeartbeats")) {
      throw new Error("Blocked untrusted schedule:listHeartbeats request.");
    }
    return options.schedulerService.listHeartbeats();
  });

  ipcMain.handle(
    "schedule:listConversationEvents",
    (event, payload: { conversationId?: string; maxItems?: number }) => {
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
      return options.schedulerService.listConversationEvents(
        conversationId,
        Number.isFinite(maxItems) ? maxItems : undefined,
      );
    },
  );

  ipcMain.handle(
    "schedule:getConversationEventCount",
    (event, payload: { conversationId?: string }) => {
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
      return options.schedulerService.getConversationEventCount(conversationId);
    },
  );
};
