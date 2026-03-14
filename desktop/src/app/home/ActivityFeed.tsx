import { DashboardCard } from "./DashboardCard"
import type { ActivityItem } from "./schedule-item"

function formatRelativeTime(ms: number): string {
  const now = Date.now()
  const diff = now - ms
  const abs = Math.abs(diff)
  const future = diff < 0

  let unit: string
  if (abs < 60_000) unit = "<1m"
  else if (abs < 3_600_000) unit = `${Math.floor(abs / 60_000)}m`
  else if (abs < 86_400_000) unit = `${Math.floor(abs / 3_600_000)}h`
  else unit = `${Math.floor(abs / 86_400_000)}d`

  return future ? `in ${unit}` : `${unit} ago`
}

function statusValue(status?: string): string {
  if (!status) return "none"
  if (status === "ok" || status === "sent" || status === "completed") return "ok"
  if (status === "error" || status === "failed") return "error"
  if (status === "canceled" || status === "cancelled") return "canceled"
  if (status === "running") return "running"
  return "none"
}

function kindLabel(kind: ActivityItem["kind"]): string {
  if (kind === "scheduled") return "Scheduled"
  if (kind === "monitoring") return "Monitoring"
  return "Task"
}

type ActivityFeedProps = {
  items: ActivityItem[]
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  return (
    <DashboardCard label="Activity" data-stella-label="Activity Feed" data-stella-state={`${items.length} items`}>
      <div className="activity-feed-list">
        {items.map((item) => (
          <div
            key={item.id}
            className="activity-feed-item"
            data-status={statusValue(item.lastStatus)}
          >
            <div className="activity-feed-header">
              <span className="activity-feed-name">{item.name}</span>
              <span className="activity-feed-time">
                {item.lastRunAtMs
                  ? formatRelativeTime(item.lastRunAtMs)
                  : "Not run yet"}
              </span>
            </div>
            <div className="activity-feed-meta">
              <span className="activity-feed-kind">{kindLabel(item.kind)}</span>
              {item.nextRunAtMs && (
                <>
                  <span className="activity-feed-sep" aria-hidden="true">·</span>
                  <span className="activity-feed-time">
                    Next {formatRelativeTime(item.nextRunAtMs)}
                  </span>
                </>
              )}
            </div>
            {item.outputPreview && (
              <div className="activity-feed-preview">{item.outputPreview}</div>
            )}
          </div>
        ))}
      </div>
    </DashboardCard>
  )
}
