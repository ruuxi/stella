export type ScheduleItem = {
  id: string
  kind: "scheduled" | "monitoring"
  name: string
  description?: string
  enabled: boolean
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
  lastStatus?: "running" | "completed" | "error"
  outputPreview?: string
}

export type ActivityItem = ScheduleItem | TaskActivityItem
