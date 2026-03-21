import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { LocalSchedulerService } from "../services/local-scheduler-service.js";

type ScheduleHandlersOptions = {
  getSchedulerService: () => LocalSchedulerService | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null;
};

export const registerScheduleHandlers = (options: ScheduleHandlersOptions) => {
  let subscribedScheduler: LocalSchedulerService | null = null;

  const getSchedulerService = () => {
    const schedulerService = options.getSchedulerService();
    if (!schedulerService) {
      throw new Error("Scheduler service not available.");
    }
    return schedulerService;
  };

  const broadcastUpdate = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("schedule:updated");
      }
    }
    options.getBroadcastToMobile?.()?.("schedule:updated", null);
  };

  const ensureSubscription = () => {
    const schedulerService = options.getSchedulerService();
    if (!schedulerService || schedulerService === subscribedScheduler) {
      return;
    }

    subscribedScheduler = schedulerService;
    schedulerService.subscribe(() => {
      broadcastUpdate();
    });
  };

  ipcMain.handle("schedule:listCronJobs", (event) => {
    if (!options.assertPrivilegedSender(event, "schedule:listCronJobs")) {
      throw new Error("Blocked untrusted schedule:listCronJobs request.");
    }
    ensureSubscription();
    return getSchedulerService().listCronJobs();
  });

  ipcMain.handle("schedule:listHeartbeats", (event) => {
    if (!options.assertPrivilegedSender(event, "schedule:listHeartbeats")) {
      throw new Error("Blocked untrusted schedule:listHeartbeats request.");
    }
    ensureSubscription();
    return getSchedulerService().listHeartbeats();
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
      ensureSubscription();
      return getSchedulerService().listConversationEvents(
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
      ensureSubscription();
      return getSchedulerService().getConversationEventCount(conversationId);
    },
  );
};
