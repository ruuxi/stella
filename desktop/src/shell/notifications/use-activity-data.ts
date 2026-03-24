import { useEffect, useMemo, useState } from "react"
import { useConversationEvents } from "@/app/chat/hooks/use-conversation-events"
import { useAgentSessionStartedAt } from "@/app/chat/hooks/use-agent-session-started-at"
import { extractTasksFromEvents } from "@/app/chat/lib/event-transforms"
import type {
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
} from "@/shared/types/electron"
import type { ActivityItem, ScheduleItem } from "@/app/home/schedule-item"
import { sortActivityItems, compareActivityItems } from "@/app/home/activity-order"

function useScheduleData(): ScheduleItem[] {
  const [cronJobs, setCronJobs] = useState<LocalCronJobRecord[]>([])
  const [heartbeats, setHeartbeats] = useState<LocalHeartbeatConfigRecord[]>([])

  useEffect(() => {
    const scheduleApi = window.electronAPI?.schedule
    if (!scheduleApi) return

    let cancelled = false

    const load = async () => {
      try {
        const [nextCronJobs, nextHeartbeats] = await Promise.all([
          scheduleApi.listCronJobs(),
          scheduleApi.listHeartbeats(),
        ])
        if (cancelled) return
        setCronJobs(nextCronJobs)
        setHeartbeats(nextHeartbeats)
      } catch {
        if (cancelled) return
        setCronJobs([])
        setHeartbeats([])
      }
    }

    void load()
    const unsubscribe = scheduleApi.onUpdated(() => {
      void load()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return useMemo(() => {
    const items: ScheduleItem[] = []

    for (const job of cronJobs) {
      if (!job.enabled) continue
      items.push({
        id: job.id,
        kind: "scheduled",
        name: job.name,
        description: job.description,
        nextRunAtMs: job.nextRunAtMs,
        lastRunAtMs: job.lastRunAtMs,
        lastStatus: job.lastStatus,
        outputPreview: job.lastOutputPreview,
      })
    }

    for (const hb of heartbeats) {
      if (!hb.enabled) continue
      const name = hb.prompt
        ? hb.prompt.slice(0, 40) + (hb.prompt.length > 40 ? "..." : "")
        : "Heartbeat"
      items.push({
        id: hb.id,
        kind: "monitoring",
        name,
        nextRunAtMs: hb.nextRunAtMs,
        lastRunAtMs: hb.lastRunAtMs,
        lastStatus: hb.lastStatus,
        outputPreview: hb.lastSentText,
      })
    }

    return items.toSorted((a, b) => compareActivityItems(a, b))
  }, [cronJobs, heartbeats])
}

/** Max items shown per section in the notification panel */
export const MAX_TASKS = 6
export const MAX_SCHEDULED = 4

export type NotificationData = {
  tasks: ActivityItem[]
  scheduled: ActivityItem[]
  totalCount: number
}

export function useActivityData(conversationId?: string): NotificationData {
  const events = useConversationEvents(conversationId)
  const appSessionStartedAtMs = useAgentSessionStartedAt()
  const scheduleItems = useScheduleData()

  const taskItems = useMemo(
    () => extractTasksFromEvents(events, { appSessionStartedAtMs }),
    [appSessionStartedAtMs, events],
  )

  return useMemo(() => {
    const tasks: ActivityItem[] = taskItems.map((task) => ({
      id: `task-${task.id}`,
      kind: "task",
      name: task.description,
      description: task.agentType,
      lastRunAtMs: task.lastUpdatedAtMs,
      lastStatus: task.status,
      outputPreview:
        task.status === "running"
          ? task.statusText ?? task.outputPreview
          : task.outputPreview ?? task.statusText,
    }))

    const allTasks = sortActivityItems(tasks)
    const allScheduled = sortActivityItems([...scheduleItems])

    return {
      tasks: allTasks.slice(0, MAX_TASKS),
      scheduled: allScheduled.slice(0, MAX_SCHEDULED),
      totalCount: allTasks.length + allScheduled.length,
    }
  }, [scheduleItems, taskItems])
}
