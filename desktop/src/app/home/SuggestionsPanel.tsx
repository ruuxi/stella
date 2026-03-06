import { memo } from "react"
import type { WelcomeSuggestion } from "@/services/synthesis"
import { DashboardCard } from "./DashboardCard"

const CATEGORY_LABELS: Record<WelcomeSuggestion["category"], string> = {
  cron: "Automation",
  skill: "Skill",
  app: "App",
}

type SuggestionsPanelProps = {
  suggestions: WelcomeSuggestion[]
  onSuggestionClick: (s: WelcomeSuggestion) => void
}

function SuggestionsPanelView({ suggestions, onSuggestionClick }: SuggestionsPanelProps) {
  return (
    <DashboardCard label="Suggestions" data-stella-label="Suggestions" data-stella-state={`${suggestions.length} items`}>
      <div className="home-suggestions">
        {suggestions.map((s) => (
          <button
            key={`${s.category}:${s.title}:${s.prompt}`}
            className="home-suggestion-card"
            onClick={() => onSuggestionClick(s)}
            data-stella-action={s.title}
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
    </DashboardCard>
  )
}

export const SuggestionsPanel = memo(SuggestionsPanelView)
