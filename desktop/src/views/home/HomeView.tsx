import { useMemo } from "react"
import { useQuery } from "convex/react"
import { useConversationEvents, getRunningTasks } from "@/hooks/use-conversation-events"
import { useWelcomeSuggestions } from "@/hooks/use-welcome-suggestions"
import { useChatStore } from "@/app/state/chat-store"
import { api } from "@/convex/api"
import type { WelcomeSuggestion } from "@/services/synthesis"
import { NewsFeed } from "./NewsFeed"
import { ImageGallery } from "./ImageGallery"
import { MusicPlayer } from "./MusicPlayer"
import { GenerativeCanvas } from "./GenerativeCanvas"
import { SuggestionsPanel } from "./SuggestionsPanel"
import { ActiveTasks } from "./ActiveTasks"
import { ActivityFeed } from "./ActivityFeed"
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

function useScheduleData(): ScheduleItem[] {
  const { cloudFeaturesEnabled } = useChatStore()

  const cronJobs = useQuery(
    api.scheduling.dashboard_queries.listCronJobs,
    cloudFeaturesEnabled ? {} : "skip",
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
    cloudFeaturesEnabled ? {} : "skip",
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
}

export function HomeView({ conversationId }: HomeViewProps) {
  const events = useConversationEvents(conversationId)
  const welcomeSuggestions = useWelcomeSuggestions(events)
  const runningTasks = getRunningTasks(events)
  const scheduleItems = useScheduleData()

  const hasSuggestions = welcomeSuggestions.length > 0
  const hasTasks = runningTasks.length > 0
  const hasSchedule = scheduleItems.length > 0

  const handleSuggestionClick = (suggestion: WelcomeSuggestion) => {
    window.dispatchEvent(
      new CustomEvent("stella:send-message", {
        detail: { text: suggestion.prompt },
      }),
    )
  }

  return (
    <div className="home-root">
      <div className="home-dashboard">
        <div className="home-zone-news">
          <NewsFeed />
        </div>
        <div className="home-zone-gallery">
          <ImageGallery />
        </div>
        <div className="home-zone-canvas">
          <GenerativeCanvas />
        </div>
        <div className="home-zone-sidebar">
          <MusicPlayer />
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
      </div>
    </div>
  )
}
