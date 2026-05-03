/**
 * Read all schedules (cron jobs + heartbeat) for a single conversation and
 * stay live via the renderer-facing `schedule:onUpdated` push. Combined into
 * a single sorted-by-next-run list of `ScheduleEntry`s so the UI can render
 * one homogeneous "Up next" strip without caring whether each row came from
 * a cron job or the conversation's heartbeat.
 *
 * No mutation surface here — edit / pause / run-now flows go through
 * `window.electronAPI.schedule` directly from whichever component owns the
 * affordance. This hook is read-only and best-effort: any failure resolves
 * to an empty list, mirroring the existing `use-conversation-events` IPC
 * fallback.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  LocalCronJobRecord,
  LocalCronSchedule,
  LocalHeartbeatConfigRecord,
} from "../../../../runtime/kernel/shared/scheduling";

export type ScheduleEntry =
  | {
      kind: "cron";
      id: string;
      name: string;
      enabled: boolean;
      nextRunAtMs: number;
      schedule: LocalCronSchedule;
    }
  | {
      kind: "heartbeat";
      id: string;
      name: string;
      enabled: boolean;
      nextRunAtMs: number;
      intervalMs: number;
    };

const heartbeatDisplayName = (
  record: LocalHeartbeatConfigRecord,
): string => {
  const prompt = record.prompt?.trim();
  if (prompt) {
    // Heartbeat prompts are short instructions; first ~60 chars is enough
    // to identify the schedule without dumping the whole checklist.
    return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  }
  return "Check-in";
};

const sortByNextRun = (entries: ScheduleEntry[]): ScheduleEntry[] =>
  [...entries].sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);

const EMPTY: ScheduleEntry[] = [];

export function useConversationSchedules(
  conversationId: string | null,
): ScheduleEntry[] {
  const [crons, setCrons] = useState<LocalCronJobRecord[]>([]);
  const [heartbeats, setHeartbeats] = useState<LocalHeartbeatConfigRecord[]>(
    [],
  );

  useEffect(() => {
    if (!conversationId || !window.electronAPI?.schedule) {
      setCrons([]);
      setHeartbeats([]);
      return;
    }
    const api = window.electronAPI.schedule;
    let cancelled = false;

    const load = async () => {
      try {
        const [cronList, heartbeatList] = await Promise.all([
          api.listCronJobs(),
          api.listHeartbeats(),
        ]);
        if (cancelled) return;
        setCrons(cronList);
        setHeartbeats(heartbeatList);
      } catch {
        if (cancelled) return;
        setCrons([]);
        setHeartbeats([]);
      }
    };

    void load();
    const unsubscribe = api.onUpdated(() => {
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId]);

  return useMemo(() => {
    if (!conversationId) return EMPTY;
    const entries: ScheduleEntry[] = [];
    for (const cron of crons) {
      if (cron.conversationId !== conversationId) continue;
      if (!cron.enabled) continue;
      entries.push({
        kind: "cron",
        id: cron.id,
        name: cron.name?.trim() || "Scheduled task",
        enabled: cron.enabled,
        nextRunAtMs: cron.nextRunAtMs,
        schedule: cron.schedule,
      });
    }
    for (const heartbeat of heartbeats) {
      if (heartbeat.conversationId !== conversationId) continue;
      if (!heartbeat.enabled) continue;
      entries.push({
        kind: "heartbeat",
        id: heartbeat.id,
        name: heartbeatDisplayName(heartbeat),
        enabled: heartbeat.enabled,
        nextRunAtMs: heartbeat.nextRunAtMs,
        intervalMs: heartbeat.intervalMs,
      });
    }
    return sortByNextRun(entries);
  }, [conversationId, crons, heartbeats]);
}
