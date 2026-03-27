import { AnimatePresence, motion } from "motion/react"
import type { ActivityItem } from "@/app/home/schedule-item"
import type { NotificationData } from "./use-activity-data"
import "./notification-panel.css"

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

function isFailedStatus(status?: string): boolean {
  return status === "error" || status === "failed"
}

function statusValue(status?: string): string {
  if (!status) return "none"
  if (status === "ok" || status === "sent" || status === "completed") return "ok"
  if (status === "error" || status === "failed") return "error"
  if (status === "canceled" || status === "cancelled") return "canceled"
  if (status === "running") return "running"
  return "none"
}

function TaskItem({ item }: { item: ActivityItem }) {
  const failed = isFailedStatus(item.lastStatus)

  if (failed) {
    // Minimal failed task row
    return (
      <div className="notif-item notif-item--failed" data-status="error">
        <div className="notif-item-row">
          <span className="notif-item-name notif-item-name--failed">{item.name}</span>
          <span className="notif-item-time">
            {item.lastRunAtMs !== undefined
              ? formatRelativeTime(item.lastRunAtMs)
              : ""}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="notif-item" data-status={statusValue(item.lastStatus)}>
      <div className="notif-item-row">
        <span className="notif-item-name">{item.name}</span>
        <span className="notif-item-time">
          {item.lastRunAtMs !== undefined
            ? formatRelativeTime(item.lastRunAtMs)
            : "Not run yet"}
        </span>
      </div>
      {item.outputPreview && (
        <div className="notif-item-preview">{item.outputPreview}</div>
      )}
    </div>
  )
}

function ScheduleItem({ item }: { item: ActivityItem }) {
  return (
    <div className="notif-item notif-item--schedule" data-status={statusValue(item.lastStatus)}>
      <div className="notif-item-row">
        <span className="notif-item-name">{item.name}</span>
        <span className="notif-item-time">
          {item.nextRunAtMs !== undefined
            ? formatRelativeTime(item.nextRunAtMs)
            : item.lastRunAtMs !== undefined
              ? formatRelativeTime(item.lastRunAtMs)
              : ""}
        </span>
      </div>
      {item.nextRunAtMs !== undefined && (
        <div className="notif-item-next">
          Next {formatRelativeTime(item.nextRunAtMs)}
        </div>
      )}
    </div>
  )
}

type NotificationPanelProps = {
  open: boolean
  data: NotificationData
  style?: React.CSSProperties
}

export function NotificationPanel({ open, data, style }: NotificationPanelProps) {
  const hasAny = data.tasks.length > 0 || data.scheduled.length > 0

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="notif-panel"
          className="notif-panel"
          style={style}
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.96 }}
          transition={{ type: "spring", duration: 0.25, bounce: 0 }}
        >
          {!hasAny ? (
            <div className="notif-empty">No activity yet</div>
          ) : (
            <>
              {data.tasks.length > 0 && (
                <div className="notif-section">
                  <div className="notif-section-label">Tasks</div>
                  <div className="notif-list">
                    {data.tasks.map((item) => (
                      <TaskItem key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              )}

              {data.scheduled.length > 0 && (
                <div className="notif-section">
                  <div className="notif-section-label">Scheduled</div>
                  <div className="notif-list">
                    {data.scheduled.map((item) => (
                      <ScheduleItem key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
