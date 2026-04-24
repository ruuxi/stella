import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { registerPrivilegedHandle } from "./privileged-ipc.js";

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

  registerPrivilegedHandle(options, "schedule:listCronJobs", async () => {
    return await (await waitForRunner()).listCronJobs();
  });

  registerPrivilegedHandle(options, "schedule:listHeartbeats", async () => {
    return await (await waitForRunner()).listHeartbeats();
  });

  registerPrivilegedHandle(
    options,
    "schedule:listConversationEvents",
    async (_event, payload: { conversationId?: string; maxItems?: number }) => {
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

  registerPrivilegedHandle(
    options,
    "schedule:getConversationEventCount",
    async (_event, payload: { conversationId?: string }) => {
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
