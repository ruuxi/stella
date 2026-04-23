import type { TaskLifecycleStatus } from "@/shared/contracts/agent-runtime"

export type ScheduleItem = {
  id: string
  kind: "scheduled" | "monitoring"
  name: string
  description?: string
  nextRunAtMs: number
  lastRunAtMs?: number
  lastStatus?: string
  outputPreview?: string
}

export type TaskActivityItem = {
  id: string
  kind: "task"
  name: string
  description?: string
  nextRunAtMs?: number
  lastRunAtMs: number
  lastStatus?: TaskLifecycleStatus
  outputPreview?: string
}

export type ActivityItem = ScheduleItem | TaskActivityItem
