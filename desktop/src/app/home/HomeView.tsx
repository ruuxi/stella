import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react"
import { useConversationEvents } from "@/hooks/use-conversation-events"
import { getRunningTasks } from "@/lib/event-transforms"
import { useWelcomeSuggestions } from "@/hooks/use-welcome-suggestions"
import type { WelcomeSuggestion } from "@/services/synthesis"
import type {
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
} from "@/types/electron"
import { NewsFeed } from "./NewsFeed"
import { ImageGallery } from "./ImageGallery"
import { GenerativeCanvas } from "./GenerativeCanvas"
import { SuggestionsPanel } from "./SuggestionsPanel"
import { ActiveTasks } from "./ActiveTasks"
import { ActivityFeed } from "./ActivityFeed"
import { DashboardCard } from "./DashboardCard"
import "./home-view.css"
import "./home-dashboard.css"

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

const MusicPlayer = lazy(() =>
  import("./MusicPlayer").then((module) => ({ default: module.MusicPlayer })),
)

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

    items.sort((a, b) => (b.lastRunAtMs ?? 0) - (a.lastRunAtMs ?? 0))
    return items
  }, [cronJobs, heartbeats])
}

type HomeViewProps = {
  conversationId?: string
}

export function HomeView({ conversationId }: HomeViewProps) {
  const events = useConversationEvents(conversationId)
  const welcomeSuggestions = useWelcomeSuggestions(events)
  const runningTasks = useMemo(() => getRunningTasks(events), [events])
  const scheduleItems = useScheduleData()

  const hasSuggestions = welcomeSuggestions.length > 0
  const hasTasks = runningTasks.length > 0
  const hasSchedule = scheduleItems.length > 0

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
        <div className="home-zone-news">
          <NewsFeed />
        </div>
        <div className="home-zone-sidebar">
          <ImageGallery />
          {hasSuggestions && (
            <SuggestionsPanel
              suggestions={welcomeSuggestions}
              onSuggestionClick={handleSuggestionClick}
            />
          )}
          {hasTasks && <ActiveTasks tasks={runningTasks} />}
          {hasSchedule && <ActivityFeed items={scheduleItems} />}
          {!hasSuggestions && !hasTasks && !hasSchedule && (
            <DashboardCard label="Activity">
              <span className="home-sidebar-empty">
                Your activity will appear here as you use Stella
              </span>
            </DashboardCard>
          )}
        </div>
        <div className="home-zone-music">
          <Suspense
            fallback={
              <DashboardCard label="Ambient">
                <span className="home-sidebar-empty">Loading ambient controls...</span>
              </DashboardCard>
            }
          >
            <MusicPlayer />
          </Suspense>
        </div>
      </div>
    </div>
  )
}

