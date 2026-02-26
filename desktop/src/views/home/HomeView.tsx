import { useMemo } from "react"
import { useConvexAuth, useQuery } from "convex/react"
import { useConversationEvents, getRunningTasks, type ConversationEventsSource } from "@/hooks/use-conversation-events"
import { useWelcomeSuggestions } from "@/hooks/use-welcome-suggestions"
import { StellaAnimation } from "@/components/StellaAnimation"
import { api } from "@/convex/api"
import type { WelcomeSuggestion } from "@/services/synthesis"

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

type HomeViewProps = {
  conversationId?: string
  eventsSource?: ConversationEventsSource
}

export function HomeView({ conversationId, eventsSource }: HomeViewProps) {
  const events = useConversationEvents(conversationId, { source: eventsSource ?? "cloud" })
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
    <div className="home-root">
      <div className="home-content">
        {isEmpty ? (
          <div className="home-empty">
            <div className="home-stella-orb">
              <StellaAnimation width={64} height={48} />
            </div>
            <span className="home-empty-text">
              Your dashboard will populate as you use Stella
            </span>
          </div>
        ) : (
          <>
            {hasSuggestions && (
              <div>
                <div className="home-section-label">Suggestions</div>
                <div className="home-suggestions">
                  {welcomeSuggestions.map((s, i) => (
                    <button
                      key={i}
                      className="home-suggestion-card"
                      onClick={() => handleSuggestionClick(s)}
                    >
                      <div className="home-suggestion-content">
                        <div className="home-suggestion-header">
                          <span className="home-suggestion-title">{s.title}</span>
                          <span className="home-suggestion-badge" data-category={s.category}>
                            {CATEGORY_LABELS[s.category]}
                          </span>
                        </div>
                        <span className="home-suggestion-desc">{s.description}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="home-stella-orb">
              <StellaAnimation width={64} height={48} />
            </div>

            {hasTasks && (
              <div>
                <div className="home-section-label">Active Tasks</div>
                <div className="home-tasks">
                  {runningTasks.map((task) => (
                    <div key={task.id} className="home-task-card">
                      <div className="home-task-description">{task.description}</div>
                      <div className="home-task-meta">
                        <span className="home-task-agent-badge">{task.agentType}</span>
                        {task.statusText && (
                          <span className="home-task-status">{task.statusText}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hasSchedule && (
              <div>
                <div className="home-section-label">Activity</div>
                <div className="home-conveyor">
                  {scheduleItems.map((item) => (
                    <div key={item.id} className="home-schedule-card">
                      <div className="home-schedule-header">
                        <span className="home-schedule-name">{item.name}</span>
                        <span className="home-schedule-kind" data-kind={item.kind}>
                          {item.kind === "scheduled" ? "Scheduled" : "Monitoring"}
                        </span>
                      </div>
                      <div className="home-schedule-status">
                        <span
                          className="home-schedule-dot"
                          data-status={statusDotValue(item.lastStatus)}
                        />
                        <span className="home-schedule-time">
                          {item.lastRunAtMs
                            ? formatRelativeTime(item.lastRunAtMs)
                            : "Not run yet"}
                        </span>
                      </div>
                      {item.nextRunAtMs && (
                        <div className="home-schedule-time">
                          Next: {formatRelativeTime(item.nextRunAtMs)}
                        </div>
                      )}
                      {item.outputPreview && (
                        <div className="home-schedule-preview">{item.outputPreview}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
