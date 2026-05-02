import { useEffect, useMemo, useState } from "react"
import {
  listLocalEvents,
  subscribeToLocalChatUpdates,
} from "@/app/chat/services/local-chat-store"
import type { OnboardingHomeSuggestion } from "@/shared/contracts/onboarding"

type SuggestionOption = {
  label: string
  prompt: string
}

type SuggestionCategory = {
  label: string
  options: SuggestionOption[]
}

const DEFAULT_CATEGORIES: SuggestionCategory[] = [
  { label: "Stella", options: [
    { label: "Make a morning dashboard", prompt: "Build a morning dashboard for my home page with the information I care about most." },
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
  { label: "Skills", options: [
    { label: "Save my PDF workflow", prompt: "Create a Stella skill for my repeated PDF workflows. Put it under state/skills and include clear instructions for reading, editing, rendering, and validating PDFs." },
    { label: "Remember project conventions", prompt: "Create or update a Stella skill that captures the recurring conventions from this project so future agents can follow them without rediscovering them." },
    { label: "Turn this into a skill", prompt: "Review the recent work in this conversation and create a reusable Stella skill for any durable pattern you find." },
    { label: "Improve an existing skill", prompt: "Review state/skills for the closest existing skill to my recent workflow and update it if the instructions are stale or incomplete." },
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
  skill: "Skills",
  schedule: "Schedule",
}

const CATEGORY_ORDER: OnboardingHomeSuggestion["category"][] = [
  "stella", "task", "skill", "schedule",
]

function buildCategoriesFromSuggestions(
  suggestions: OnboardingHomeSuggestion[],
): SuggestionCategory[] {
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

/**
 * Read persisted onboarding-personalized suggestions for the conversation
 * and fall back to `DEFAULT_CATEGORIES` until they arrive (or if loading
 * fails). Used by the Ideas display tab.
 */
export function usePersonalizedCategories(
  conversationId: string | null,
): SuggestionCategory[] {
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
    // Re-read on any local-chat update so background suggestion refreshes
    // surface without a remount or conversation switch.
    const unsubscribe = subscribeToLocalChatUpdates(() => {
      void load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [conversationId])

  return useMemo(
    () =>
      persisted && persisted.length > 0
        ? buildCategoriesFromSuggestions(persisted)
        : DEFAULT_CATEGORIES,
    [persisted],
  )
}
