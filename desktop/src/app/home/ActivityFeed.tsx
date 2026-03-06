import { DashboardCard } from "./DashboardCard"

type ScheduleItem = {
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

function formatRelativeTime(ms: number): string {
  const now = Date.now()
  const diff = now - ms
  if (diff < 0) {
    const abs = -diff
    if (abs < 60_000) return "in <1m"
    if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`
    if (abs < 86_400_000) return `in ${Math.round(abs / 3_600_000)}h`
    return `in ${Math.round(abs / 86_400_000)}d`
  }
  if (diff < 60_000) return "<1m ago"
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function statusDotValue(status?: string): string {
  if (!status) return "none"
  if (status === "ok" || status === "sent" || status === "completed") return "ok"
  if (status === "error" || status === "failed") return "error"
  return "none"
}

type ActivityFeedProps = {
  items: ScheduleItem[]
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  return (
    <DashboardCard label="Activity" data-stella-label="Activity Feed" data-stella-state={`${items.length} items`}>
      <div className="activity-feed-list">
        {items.map((item) => (
          <div key={item.id} className="activity-feed-item">
            <div className="activity-feed-header">
              <span className="activity-feed-name">{item.name}</span>
              <span className="activity-feed-kind" data-kind={item.kind}>
                {item.kind === "scheduled" ? "Scheduled" : "Monitoring"}
              </span>
            </div>
            <div className="activity-feed-status">
              <span
                className="activity-feed-dot"
                data-status={statusDotValue(item.lastStatus)}
              />
              <span className="activity-feed-time">
                {item.lastRunAtMs
                  ? formatRelativeTime(item.lastRunAtMs)
                  : "Not run yet"}
              </span>
            </div>
            {item.nextRunAtMs && (
              <div className="activity-feed-time">
                Next: {formatRelativeTime(item.nextRunAtMs)}
              </div>
            )}
            {item.outputPreview && (
              <div className="activity-feed-preview">{item.outputPreview}</div>
            )}
          </div>
        ))}
      </div>
    </DashboardCard>
  )
}
