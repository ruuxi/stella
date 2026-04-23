import { useEffect, useMemo, useState, type ReactNode } from "react"
import { listLocalEvents } from "@/app/chat/services/local-chat-store"
import type { OnboardingHomeSuggestion } from "@/shared/contracts/onboarding"
import "./home.css"

export type SuggestionOption = {
  label: string
  prompt: string
}

export type SuggestionCategory = {
  label: string
  options: SuggestionOption[]
}

type Category = SuggestionCategory

// eslint-disable-next-line react-refresh/only-export-components
export const DEFAULT_CATEGORIES: Category[] = [
  { label: "Stella", options: [
    { label: "Add a music player to home", prompt: "Add the music player to my home page. The component is already built and ready - exists at src/app/home/MusicPlayer.tsx - integrate it into the Home.tsx page layout, don't rebuild it." },
    { label: "Change my theme to dark", prompt: "Change my theme to dark mode" },
    { label: "Build me a budget tracker app", prompt: "Build me a budget tracker app" },
    { label: "Create a habit tracker app", prompt: "Create a habit tracker app" },
    { label: "Make me sound more casual", prompt: "Change your personality to sound more casual and friendly" },
  ]},
  { label: "Task", options: [
    { label: "Book a restaurant nearby", prompt: "Book a restaurant nearby" },
    { label: "Fix a bug in my project", prompt: "Fix a bug in my project" },
    { label: "Order groceries online", prompt: "Order groceries online" },
    { label: "Fill out a form for me", prompt: "Fill out a form for me" },
  ]},
  { label: "Explore", options: [
    { label: "What's happening in the news", prompt: "What's happening in the news today?" },
    { label: "Find the best laptop under $1000", prompt: "Find the best laptop under $1000" },
    { label: "Look up flights to Tokyo", prompt: "Look up flights to Tokyo" },
    { label: "Compare iPhone vs Pixel", prompt: "Compare the latest iPhone vs the latest Pixel" },
  ]},
  { label: "Schedule", options: [
    { label: "Remind me to stretch every hour", prompt: "Remind me to stretch every hour" },
    { label: "Send me a daily news briefing", prompt: "Every morning at 9am, send me a news briefing" },
    { label: "Check my email every morning", prompt: "Every morning at 8am, check my email and summarize what's new" },
    { label: "Monitor a website for changes", prompt: "Monitor a website for changes" },
  ]},
]

const CATEGORY_LABEL_MAP: Record<OnboardingHomeSuggestion["category"], string> = {
  stella: "Stella",
  task: "Task",
  explore: "Explore",
  schedule: "Schedule",
}

const CATEGORY_ORDER: OnboardingHomeSuggestion["category"][] = [
  "stella", "task", "explore", "schedule",
]

function buildCategoriesFromSuggestions(
  suggestions: OnboardingHomeSuggestion[],
): Category[] {
  const grouped = new Map<string, SuggestionOption[]>()
  for (const s of suggestions) {
    const key = s.category
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push({ label: s.label, prompt: s.prompt })
  }
  return CATEGORY_ORDER
    .filter((key) => grouped.has(key))
    .map((key) => ({
      label: CATEGORY_LABEL_MAP[key],
      options: grouped.get(key)!,
    }))
}

function usePersonalizedCategories(conversationId: string | null): Category[] {
  const [persisted, setPersisted] = useState<OnboardingHomeSuggestion[] | null>(null)

  useEffect(() => {
    if (!conversationId) return

    let cancelled = false

    const load = async () => {
      try {
        const events = await listLocalEvents(conversationId, 200)
        const suggestionsEvent = events.findLast((e) => e.type === "home_suggestions")
        if (cancelled) return
        if (
          suggestionsEvent?.payload &&
          Array.isArray((suggestionsEvent.payload as { suggestions?: unknown }).suggestions)
        ) {
          setPersisted(
            (suggestionsEvent.payload as { suggestions: OnboardingHomeSuggestion[] }).suggestions,
          )
        }
      } catch {
        // fall through - defaults will be used
      }
    }

    void load()
    return () => { cancelled = true }
  }, [conversationId])

  return useMemo(
    () =>
      persisted && persisted.length > 0
        ? buildCategoriesFromSuggestions(persisted)
        : DEFAULT_CATEGORIES,
    [persisted],
  )
}

type HomeContentProps = {
  conversationId: string | null
  onSuggestionClick: (prompt: string) => void
  children?: ReactNode
}

function getTimeBasedGreeting(date: Date): string {
  const hour = date.getHours()
  if (hour < 5) return "Good night"
  if (hour < 12) return "Good morning"
  if (hour < 17) return "Good afternoon"
  if (hour < 21) return "Good evening"
  return "Good night"
}

const FUN_GREETINGS: readonly string[] = [
  "Welcome back!",
  "Hey there!",
  "Glad you're here",
  "Ready when you are",
  "Let's make today great",
  "What's on your mind?",
  "Where should we start?",
  "Let's dive in",
  "Good to see you",
  "Hey, I'm all ears",
  "Let's create something",
  "Ready to roll?",
  "What are we tackling?",
  "Hello, friend",
  "Howdy!",
  "Welcome aboard",
  "Let's go!",
  "What's up?",
  "Let's make magic",
  "Pick a quest",
  "Adventure awaits",
  "Let's build something cool",
  "Good to have you back",
  "Let's do this",
  "Onward!",
  "What can we explore today?",
  "Hello, hello",
  "Greetings, traveler",
  "Let's chase some ideas",
  "Where to next?",
  "Hey, friend",
  "Ready to make a dent?",
  "Let's cook something up",
  "What's the mission?",
  "Hi! What's first?",
  "Let's get curious",
  "Bring me your best ideas",
  "Tell me everything",
  "What's the plan?",
  "Let's make something",
]

// Probability the greeting is a random fun message instead of the time-of-day greeting.
const FUN_GREETING_CHANCE = 0.25

type GreetingState =
  | { kind: "fun"; text: string }
  | { kind: "time" }

function pickInitialGreetingState(): GreetingState {
  if (Math.random() < FUN_GREETING_CHANCE) {
    const idx = Math.floor(Math.random() * FUN_GREETINGS.length)
    return { kind: "fun", text: FUN_GREETINGS[idx] }
  }
  return { kind: "time" }
}

function useGreeting(): string {
  const [state] = useState<GreetingState>(pickInitialGreetingState)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (state.kind !== "time") return
    // Re-evaluate every minute so the time-of-day greeting stays accurate across boundaries.
    const interval = setInterval(() => forceTick((n) => n + 1), 60_000)
    return () => clearInterval(interval)
  }, [state.kind])

  if (state.kind === "fun") return state.text
  return getTimeBasedGreeting(new Date())
}

export function HomeContent({ conversationId, onSuggestionClick, children }: HomeContentProps) {
  const categories = usePersonalizedCategories(conversationId)
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const [hasOpened, setHasOpened] = useState(false)
  const greeting = useGreeting()

  return (
    <div className="home-content" onClick={() => setOpenCategory(null)}>
      <h1 className="home-stella-title">
        {greeting}
      </h1>

      {children}

      <div className="home-center-group">
        <div className="home-categories">
          {categories.map((cat) => (
            <button
              key={cat.label}
              className={`home-category${openCategory === cat.label ? " active" : ""}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                const next = openCategory === cat.label ? null : cat.label
                setOpenCategory(next)
                if (next && !hasOpened) setHasOpened(true)
              }}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="home-options-reveal" data-visible={openCategory ? true : undefined} data-entered={hasOpened ? true : undefined}>
          <div className="home-options-reveal__inner">
            <div className="home-options">
              {categories.map((cat) => (
                <div
                  key={cat.label}
                  className="home-options-group"
                  data-active={openCategory === cat.label ? true : undefined}
                >
                  {cat.options.map((opt, i) => (
                    <button
                      key={opt.label}
                      className="home-option"
                      type="button"
                      style={{ "--stagger": i } as React.CSSProperties}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSuggestionClick(opt.prompt)
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
