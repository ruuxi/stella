import { useEffect, useMemo, useState } from "react"
import { listLocalEvents } from "@/app/chat/services/local-chat-store"
import { getElectronApi } from "@/platform/electron/electron"
import type { OnboardingHomeSuggestion } from "@/shared/contracts/onboarding"
import type {
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
} from "@/shared/types/electron"
import { dispatchOpenSidebarChat } from "@/shared/lib/stella-orb-chat"
import "./home.css"

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

type HomeSuggestion = {
  label: string
  prompt: string
}

const DEFAULT_SUGGESTIONS: HomeSuggestion[] = [
  { label: "summarize today's news", prompt: "Summarize today's top news" },
  {
    label: "what changed in my repo since yesterday",
    prompt: "What changed in my repo since yesterday?",
  },
  {
    label: "remind me to stretch every hour",
    prompt: "Remind me to stretch every hour",
  },
]

const SUGGESTION_LIMIT = 3

function usePersonalizedSuggestions(
  conversationId: string | null,
): HomeSuggestion[] {
  const [persisted, setPersisted] = useState<OnboardingHomeSuggestion[] | null>(null)

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false

    void (async () => {
      try {
        const events = await listLocalEvents(conversationId, 200)
        const last = events.findLast((e) => e.type === "home_suggestions")
        const suggestions = (last?.payload as { suggestions?: unknown } | undefined)
          ?.suggestions
        if (cancelled) return
        if (Array.isArray(suggestions)) {
          setPersisted(suggestions as OnboardingHomeSuggestion[])
        }
      } catch {
        /* fall through to defaults */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [conversationId])

  return useMemo(() => {
    if (persisted && persisted.length > 0) {
      return persisted
        .slice(0, SUGGESTION_LIMIT)
        .map(({ label, prompt }) => ({ label, prompt }))
    }
    return DEFAULT_SUGGESTIONS.slice(0, SUGGESTION_LIMIT)
  }, [persisted])
}

// ---------------------------------------------------------------------------
// Schedule status — single muted line, expands inline on click
// ---------------------------------------------------------------------------

type ScheduleSummary = {
  cronJobs: LocalCronJobRecord[]
  heartbeats: LocalHeartbeatConfigRecord[]
}

const SCHEDULE_REFRESH_INTERVAL_MS = 60_000

function useScheduleSummary(): ScheduleSummary {
  const [state, setState] = useState<ScheduleSummary>({
    cronJobs: [],
    heartbeats: [],
  })

  useEffect(() => {
    const api = getElectronApi()
    if (!api?.schedule) return
    let cancelled = false

    const refresh = async () => {
      try {
        const [cronJobs, heartbeats] = await Promise.all([
          api.schedule.listCronJobs(),
          api.schedule.listHeartbeats(),
        ])
        if (cancelled) return
        setState({ cronJobs, heartbeats })
      } catch {
        /* leave previous state */
      }
    }

    void refresh()
    const interval = window.setInterval(refresh, SCHEDULE_REFRESH_INTERVAL_MS)
    const off = api.schedule.onUpdated(() => void refresh())

    return () => {
      cancelled = true
      window.clearInterval(interval)
      off?.()
    }
  }, [])

  return state
}

function formatRelativeFuture(targetMs: number, nowMs: number): string {
  const delta = targetMs - nowMs
  if (delta <= 0) return "due now"
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const remMin = minutes % 60
    return remMin === 0 ? `in ${hours}h` : `in ${hours}h ${remMin}m`
  }
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function timeBasedGreeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 5) return "Late night."
  if (hour < 12) return "Good morning."
  if (hour < 17) return "Good afternoon."
  if (hour < 22) return "Good evening."
  return "Late night."
}

// ---------------------------------------------------------------------------
// Component
//
// Home is intentionally minimal: greeting, optional suggestions, and an
// optional schedule status line. Composer + auto context chips live in the
// sidebar chat — clicking a suggestion opens the sidebar and prefills the
// composer there.
// ---------------------------------------------------------------------------

type HomeViewProps = {
  conversationId: string | null
}

export function HomeContent({ conversationId }: HomeViewProps) {
  const suggestions = usePersonalizedSuggestions(conversationId)
  const { cronJobs, heartbeats } = useScheduleSummary()
  const [scheduleExpanded, setScheduleExpanded] = useState(false)
  const [greeting, setGreeting] = useState(() => timeBasedGreeting())

  // Keep the greeting fresh across the day without forcing remounts.
  useEffect(() => {
    const id = window.setInterval(() => setGreeting(timeBasedGreeting()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const enabledCron = useMemo(
    () =>
      cronJobs
        .filter((job) => job.enabled !== false)
        .sort((a, b) => a.nextRunAtMs - b.nextRunAtMs),
    [cronJobs],
  )
  const enabledHeartbeats = useMemo(
    () => heartbeats.filter((h) => h.enabled !== false),
    [heartbeats],
  )

  const nextItem = enabledCron[0] ?? null
  const totalActive = enabledCron.length + enabledHeartbeats.length
  const showScheduleLine = totalActive > 0

  const handleSuggestionClick = (prompt: string) => {
    dispatchOpenSidebarChat({ prefillText: prompt })
  }

  return (
    <div className="home-view">
      <div className="home-view__center">
        <h1 className="home-view__greeting">{greeting}</h1>

        {suggestions.length > 0 && (
          <ul className="home-view__suggestions" aria-label="Suggestions">
            {suggestions.map((s) => (
              <li key={s.label} className="home-view__suggestion-item">
                <button
                  type="button"
                  className="home-view__suggestion"
                  onClick={() => handleSuggestionClick(s.prompt)}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showScheduleLine && (
        <ScheduleStatusLine
          expanded={scheduleExpanded}
          onToggle={() => setScheduleExpanded((v) => !v)}
          nextItem={nextItem}
          watcherCount={enabledHeartbeats.length}
          allCron={enabledCron}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schedule line
// ---------------------------------------------------------------------------

type ScheduleStatusLineProps = {
  expanded: boolean
  onToggle: () => void
  nextItem: LocalCronJobRecord | null
  watcherCount: number
  allCron: LocalCronJobRecord[]
}

function ScheduleStatusLine({
  expanded,
  onToggle,
  nextItem,
  watcherCount,
  allCron,
}: ScheduleStatusLineProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const summary = (() => {
    const parts: string[] = []
    if (nextItem) {
      parts.push(
        `next ${formatRelativeFuture(nextItem.nextRunAtMs, now)} — ${nextItem.name}`,
      )
    }
    if (watcherCount > 0) {
      parts.push(`${watcherCount} watcher${watcherCount === 1 ? "" : "s"} active`)
    }
    return parts.join(" · ")
  })()

  return (
    <div className={`home-view__schedule${expanded ? " home-view__schedule--expanded" : ""}`}>
      <button
        type="button"
        className="home-view__schedule-line"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {summary}
      </button>

      {expanded && allCron.length > 0 && (
        <ul className="home-view__schedule-list">
          {allCron.slice(0, 6).map((job) => (
            <li key={job.id} className="home-view__schedule-item">
              <span className="home-view__schedule-name">{job.name}</span>
              <span className="home-view__schedule-when">
                {formatRelativeFuture(job.nextRunAtMs, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
