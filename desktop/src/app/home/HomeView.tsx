import { useCallback, useEffect, useMemo, useState } from "react"
import { useConversationEvents } from "@/app/chat/hooks/use-conversation-events"
import { extractTasksFromEvents } from "@/app/chat/lib/event-transforms"
import { useWelcomeSuggestions } from "@/app/home/hooks/use-welcome-suggestions"
import type { WelcomeSuggestion } from "@/app/onboarding/services/synthesis"
import type {
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
} from "@/types/electron"
import { GenerativeCanvas } from "./GenerativeCanvas"
import { SuggestionsPanel } from "./SuggestionsPanel"
import { ActivityFeed } from "./ActivityFeed"
import { DashboardCard } from "./DashboardCard"
import type { ActivityItem, ScheduleItem } from "./schedule-item"
import { sortActivityItems } from "./activity-order"
import "./home-view.css"
import "./home-dashboard.css"

function useScheduleData(): ScheduleItem[] {
  const [cronJobs, setCronJobs] = useState<LocalCronJobRecord[]>([])
  const [heartbeats, setHeartbeats] = useState<LocalHeartbeatConfigRecord[]>([])

  useEffect(() => {
    const scheduleApi = window.electronAPI?.schedule
    if (!scheduleApi) {
      return
    }

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

    if (cronJobs) {
      for (const job of cronJobs) {
        if (!job.enabled) continue
        items.push({
          id: job.id,
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
          id: hb.id,
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

    return sortActivityItems(items)
  }, [cronJobs, heartbeats])
}

type HomeViewProps = {
  conversationId?: string
}

export function HomeView({ conversationId }: HomeViewProps) {
  const events = useConversationEvents(conversationId)
  const welcomeSuggestions = useWelcomeSuggestions(events)
  const scheduleItems = useScheduleData()
  const taskItems = useMemo(() => extractTasksFromEvents(events), [events])
  const activityItems = useMemo<ActivityItem[]>(() => {
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

    return sortActivityItems([...tasks, ...scheduleItems])
  }, [scheduleItems, taskItems])

  const hasSuggestions = welcomeSuggestions.length > 0
  const hasActivity = activityItems.length > 0

  const handleSuggestionClick = useCallback((suggestion: WelcomeSuggestion) => {
    window.dispatchEvent(
      new CustomEvent("stella:send-message", {
        detail: { text: suggestion.prompt },
      }),
    )
  }, [])

  return (
    <div className="home-root" data-stella-view="home" data-stella-label="Home Dashboard">
      <div className="home-dashboard">
        <div className="home-zone-canvas">
          <GenerativeCanvas />
        </div>
        <div className="home-zone-sidebar">
          {hasSuggestions && (
            <SuggestionsPanel
              suggestions={welcomeSuggestions}
              onSuggestionClick={handleSuggestionClick}
            />
          )}
          {hasActivity && <ActivityFeed items={activityItems} />}
          {!hasSuggestions && !hasActivity && (
            <DashboardCard label="Activity">
              <span className="home-sidebar-empty">
                Your activity will appear here as you use Stella
              </span>
            </DashboardCard>
          )}
        </div>
      </div>
    </div>
  )
}
