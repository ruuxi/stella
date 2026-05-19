import { useAction } from "convex/react";
import { useEffect, useMemo, useRef } from "react";
import { api } from "@/convex/api";
import {
  extractTasksFromActivities,
  mergeFooterTasks,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { AGENT_IDS } from "../../../../runtime/contracts/agent-runtime.js";

const MOUNT_GRACE_MS = 2_000;

type ActivityNotificationKind = "started" | "completed" | "failed";

type TaskNotificationRecord = {
  observedRunning: boolean;
  eligibleForStartedNotification: boolean;
  startedNotified: boolean;
  terminalNotified: boolean;
};

const shouldNotifyForTask = (task: TaskItem): boolean =>
  task.agentType !== AGENT_IDS.ORCHESTRATOR;

export function MobileActivityNotificationsBridge() {
  const { hasConnectedAccount } = useAuthSessionState();
  const chat = useChatRuntime();
  const sendActivityNotification = useAction(
    api.mobile_push.sendActivityNotification,
  );
  const mountedAtMsRef = useRef(Date.now());
  const recordsRef = useRef<Map<string, TaskNotificationRecord>>(new Map());

  const allTasks = useMemo(() => {
    const persisted = extractTasksFromActivities(
      chat.conversation.activity.activities,
      {
        latestMessageTimestampMs:
          chat.conversation.activity.latestMessageTimestampMs,
      },
    );
    return mergeFooterTasks(
      persisted,
      chat.conversation.streaming.liveTasks ?? [],
    ).filter(shouldNotifyForTask);
  }, [
    chat.conversation.activity.activities,
    chat.conversation.activity.latestMessageTimestampMs,
    chat.conversation.streaming.liveTasks,
  ]);

  useEffect(() => {
    const send = (kind: ActivityNotificationKind) => {
      void sendActivityNotification({ kind }).catch((error) => {
        console.warn("[mobile-activity] Failed to send notification:", error);
      });
    };

    if (!hasConnectedAccount) {
      recordsRef.current.clear();
      return;
    }

    const seenTaskIds = new Set<string>();

    for (const task of allTasks) {
      seenTaskIds.add(task.id);
      let record = recordsRef.current.get(task.id);

      if (!record) {
        record = {
          observedRunning: task.status === "running",
          eligibleForStartedNotification:
            task.startedAtMs >= mountedAtMsRef.current - MOUNT_GRACE_MS,
          startedNotified: false,
          terminalNotified: false,
        };
        recordsRef.current.set(task.id, record);
      }

      if (task.status === "running") {
        record.observedRunning = true;
        if (
          record.eligibleForStartedNotification &&
          !record.startedNotified
        ) {
          record.startedNotified = true;
          send("started");
        }
        continue;
      }

      const terminalAtMs =
        task.completedAtMs ?? task.lastUpdatedAtMs ?? task.startedAtMs;
      const eligibleForTerminalNotification =
        record.observedRunning ||
        terminalAtMs >= mountedAtMsRef.current - MOUNT_GRACE_MS;

      if (
        !record.terminalNotified &&
        eligibleForTerminalNotification &&
        task.status !== "canceled"
      ) {
        record.terminalNotified = true;
        send(task.status === "completed" ? "completed" : "failed");
      }
    }

    for (const taskId of recordsRef.current.keys()) {
      if (seenTaskIds.has(taskId)) continue;
      recordsRef.current.delete(taskId);
    }
  }, [allTasks, hasConnectedAccount, sendActivityNotification]);

  useEffect(() => {
    return () => {
      recordsRef.current.clear();
    };
  }, []);

  return null;
}
