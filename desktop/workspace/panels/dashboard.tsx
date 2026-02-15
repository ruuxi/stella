import { useMemo } from "react"
import { useConvexAuth, useQuery } from "convex/react"
import { useUiState } from "../../src/app/state/ui-state"
import { useConversationEvents, getRunningTasks } from "../../src/hooks/use-conversation-events"
import { useWelcomeSuggestions } from "../../src/hooks/use-welcome-suggestions"
import { api } from "../../src/convex/api"
import type { WelcomeSuggestion } from "../../src/services/synthesis"

/* ── Types ── */

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

/* ── Helpers ── */

const CATEGORY_LABELS: Record<WelcomeSuggestion["category"], string> = {
  cron: "Automation",
  skill: "Skill",
  app: "App",
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

/* ── Schedule data hook (inline) ── */

function useScheduleData(): ScheduleItem[] {
  const { isAuthenticated } = useConvexAuth()

  const cronJobs = useQuery(
    api.scheduling.dashboard_queries.listCronJobs,
    isAuthenticated ? {} : "skip",
  ) as
    | {
        _id: string
        name: string
        description?: string
        enabled: boolean
        nextRunAtMs: number
        lastRunAtMs?: number
        lastStatus?: string
        lastOutputPreview?: string
      }[]
    | undefined

  const heartbeats = useQuery(
    api.scheduling.dashboard_queries.listHeartbeats,
    isAuthenticated ? {} : "skip",
  ) as
    | {
        _id: string
        enabled: boolean
        intervalMs: number
        prompt?: string
        nextRunAtMs: number
        lastRunAtMs?: number
        lastStatus?: string
        lastSentText?: string
      }[]
    | undefined

  return useMemo(() => {
    const items: ScheduleItem[] = []

    if (cronJobs) {
      for (const job of cronJobs) {
        if (!job.enabled) continue
        items.push({
          id: job._id,
          kind: "scheduled",
          name: job.name,
          description: job.description,
          enabled: job.enabled,
          nextRunAtMs: job.nextRunAtMs,
          lastRunAtMs: job.lastRunAtMs,
          lastStatus: job.lastStatus,
          outputPreview: job.lastOutputPreview,
        })
      }
    }

    if (heartbeats) {
      for (const hb of heartbeats) {
        if (!hb.enabled) continue
        const name = hb.prompt
          ? hb.prompt.slice(0, 40) + (hb.prompt.length > 40 ? "..." : "")
          : "Heartbeat"
        items.push({
          id: hb._id,
          kind: "monitoring",
          name,
          enabled: hb.enabled,
          nextRunAtMs: hb.nextRunAtMs,
          lastRunAtMs: hb.lastRunAtMs,
          lastStatus: hb.lastStatus,
          outputPreview: hb.lastSentText,
        })
      }
    }

    items.sort((a, b) => (b.lastRunAtMs ?? 0) - (a.lastRunAtMs ?? 0))
    return items
  }, [cronJobs, heartbeats])
}

/* ── CSS ── */

const css = `
  .db-root {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    font-family: var(--font-family-sans, Inter, sans-serif);
    color: var(--foreground);
    background: transparent;
    overflow: hidden;
  }
  .db-root * { box-sizing: border-box; }

  .db-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    scrollbar-width: none;
  }
  .db-content::-webkit-scrollbar { display: none; }

  .db-section-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--foreground);
    opacity: 0.4;
    margin-bottom: 8px;
  }

  /* --- Suggestions --- */

  .db-suggestions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .db-suggestion-card {
    display: flex;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    cursor: pointer;
    transition: background 0.25s, border-color 0.25s, opacity 0.25s;
    text-align: left;
    font-family: inherit;
    width: 100%;
    opacity: 0.8;
  }
  .db-suggestion-card:hover {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    border-color: color-mix(in oklch, var(--foreground) 18%, transparent);
    opacity: 1;
  }

  .db-suggestion-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .db-suggestion-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .db-suggestion-title {
    font-size: 13px;
    font-weight: 550;
    color: var(--foreground);
    line-height: 1.3;
  }
  .db-suggestion-badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1.5;
    flex-shrink: 0;
    background: none;
  }
  .db-suggestion-badge[data-category="cron"] { color: oklch(0.45 0.12 155); }
  .db-suggestion-badge[data-category="skill"] { color: oklch(0.45 0.12 250); }
  .db-suggestion-badge[data-category="app"] { color: oklch(0.50 0.12 75); }
  :root[data-theme="dark"] .db-suggestion-badge[data-category="cron"] { color: oklch(0.78 0.10 155); }
  :root[data-theme="dark"] .db-suggestion-badge[data-category="skill"] { color: oklch(0.78 0.10 250); }
  :root[data-theme="dark"] .db-suggestion-badge[data-category="app"] { color: oklch(0.80 0.10 75); }

  .db-suggestion-desc {
    font-size: 12px;
    color: var(--foreground);
    opacity: 0.5;
    line-height: 1.4;
  }

  /* --- Tasks --- */

  .db-tasks {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .db-task-card {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
  }
  .db-task-description {
    font-size: 13px;
    font-weight: 500;
    color: var(--foreground);
    line-height: 1.3;
    margin-bottom: 4px;
  }
  .db-task-meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .db-task-agent-badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: oklch(0.45 0.12 250);
  }
  :root[data-theme="dark"] .db-task-agent-badge { color: oklch(0.78 0.10 250); }

  .db-task-status {
    font-size: 11px;
    color: var(--foreground);
    opacity: 0.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* --- Schedule conveyor --- */

  .db-conveyor {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    padding-bottom: 8px;
  }
  .db-conveyor::-webkit-scrollbar { display: none; }

  .db-schedule-card {
    flex-shrink: 0;
    width: 180px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .db-schedule-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .db-schedule-name {
    font-size: 12px;
    font-weight: 550;
    color: var(--foreground);
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .db-schedule-kind {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
    padding: 1px 5px;
    border-radius: 4px;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
  }
  .db-schedule-kind[data-kind="scheduled"] { color: oklch(0.45 0.12 155); }
  .db-schedule-kind[data-kind="monitoring"] { color: oklch(0.45 0.12 280); }
  :root[data-theme="dark"] .db-schedule-kind[data-kind="scheduled"] { color: oklch(0.78 0.10 155); }
  :root[data-theme="dark"] .db-schedule-kind[data-kind="monitoring"] { color: oklch(0.78 0.10 280); }

  .db-schedule-status {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .db-schedule-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .db-schedule-dot[data-status="ok"] { background: oklch(0.65 0.18 145); }
  .db-schedule-dot[data-status="error"] { background: oklch(0.60 0.20 25); }
  .db-schedule-dot[data-status="none"] { background: color-mix(in oklch, var(--foreground) 25%, transparent); }

  .db-schedule-time {
    font-size: 11px;
    color: var(--foreground);
    opacity: 0.5;
  }
  .db-schedule-preview {
    font-size: 11px;
    color: var(--foreground);
    opacity: 0.4;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* --- Empty state --- */

  .db-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .db-empty-text {
    font-size: 12px;
    color: var(--foreground);
    opacity: 0.3;
    text-align: center;
    line-height: 1.5;
  }
`

/* ── Component ── */

export default function Dashboard() {
  const { state } = useUiState()
  const events = useConversationEvents(state.conversationId ?? undefined)
  const welcomeSuggestions = useWelcomeSuggestions(events)
  const runningTasks = getRunningTasks(events)
  const scheduleItems = useScheduleData()

  const hasSuggestions = welcomeSuggestions.length > 0
  const hasTasks = runningTasks.length > 0
  const hasSchedule = scheduleItems.length > 0
  const isEmpty = !hasSuggestions && !hasTasks && !hasSchedule

  const handleSuggestionClick = (suggestion: WelcomeSuggestion) => {
    window.dispatchEvent(
      new CustomEvent("stella:send-message", {
        detail: { text: suggestion.prompt },
      }),
    )
  }

  return (
    <>
      <style>{css}</style>
      <div className="db-root">
        <div className="db-content">
          {isEmpty && (
            <div className="db-empty">
              <span className="db-empty-text">
                Your dashboard will populate as you use Stella
              </span>
            </div>
          )}

          {hasSuggestions && (
            <div>
              <div className="db-section-label">Suggestions</div>
              <div className="db-suggestions">
                {welcomeSuggestions.map((s, i) => (
                  <button
                    key={i}
                    className="db-suggestion-card"
                    onClick={() => handleSuggestionClick(s)}
                  >
                    <div className="db-suggestion-content">
                      <div className="db-suggestion-header">
                        <span className="db-suggestion-title">{s.title}</span>
                        <span className="db-suggestion-badge" data-category={s.category}>
                          {CATEGORY_LABELS[s.category]}
                        </span>
                      </div>
                      <span className="db-suggestion-desc">{s.description}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasTasks && (
            <div>
              <div className="db-section-label">Active Tasks</div>
              <div className="db-tasks">
                {runningTasks.map((task) => (
                  <div key={task.id} className="db-task-card">
                    <div className="db-task-description">{task.description}</div>
                    <div className="db-task-meta">
                      <span className="db-task-agent-badge">{task.agentType}</span>
                      {task.statusText && (
                        <span className="db-task-status">{task.statusText}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasSchedule && (
            <div>
              <div className="db-section-label">Activity</div>
              <div className="db-conveyor">
                {scheduleItems.map((item) => (
                  <div key={item.id} className="db-schedule-card">
                    <div className="db-schedule-header">
                      <span className="db-schedule-name">{item.name}</span>
                      <span className="db-schedule-kind" data-kind={item.kind}>
                        {item.kind === "scheduled" ? "Scheduled" : "Monitoring"}
                      </span>
                    </div>
                    <div className="db-schedule-status">
                      <span
                        className="db-schedule-dot"
                        data-status={statusDotValue(item.lastStatus)}
                      />
                      <span className="db-schedule-time">
                        {item.lastRunAtMs
                          ? formatRelativeTime(item.lastRunAtMs)
                          : "Not run yet"}
                      </span>
                    </div>
                    {item.nextRunAtMs && (
                      <div className="db-schedule-time">
                        Next: {formatRelativeTime(item.nextRunAtMs)}
                      </div>
                    )}
                    {item.outputPreview && (
                      <div className="db-schedule-preview">{item.outputPreview}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
