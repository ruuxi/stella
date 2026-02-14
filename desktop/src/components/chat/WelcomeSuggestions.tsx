import type { WelcomeSuggestion } from '../../services/synthesis'

const CATEGORY_LABELS: Record<WelcomeSuggestion['category'], string> = {
  cron: 'Automation',
  skill: 'Skill',
  app: 'App',
}

type WelcomeSuggestionsProps = {
  suggestions: WelcomeSuggestion[]
  onSelect: (suggestion: WelcomeSuggestion) => void
}

export function WelcomeSuggestions({ suggestions, onSelect }: WelcomeSuggestionsProps) {
  if (suggestions.length === 0) return null

  return (
    <div className="welcome-suggestions">
      {suggestions.map((s, i) => (
        <button
          key={i}
          className="welcome-suggestion-card"
          data-category={s.category}
          onClick={() => onSelect(s)}
        >
          <span className="welcome-suggestion-emoji">{s.emoji}</span>
          <div className="welcome-suggestion-content">
            <div className="welcome-suggestion-header">
              <span className="welcome-suggestion-title">{s.title}</span>
              <span className="welcome-suggestion-badge" data-category={s.category}>
                {CATEGORY_LABELS[s.category]}
              </span>
            </div>
            <span className="welcome-suggestion-desc">{s.description}</span>
          </div>
        </button>
      ))}
    </div>
  )
}
