import type { CommandSuggestion } from '../../hooks/use-command-suggestions'

type CommandChipsProps = {
  suggestions: CommandSuggestion[]
  onSelect: (suggestion: CommandSuggestion) => void
}

export function CommandChips({ suggestions, onSelect }: CommandChipsProps) {
  if (suggestions.length === 0) return null

  return (
    <div className="command-chips">
      {suggestions.map((s) => (
        <button
          key={s.commandId}
          className="command-chip"
          onClick={() => onSelect(s)}
          title={s.description}
        >
          {s.name}
        </button>
      ))}
    </div>
  )
}
