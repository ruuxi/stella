import type { WelcomeSuggestion } from "@/global/onboarding/services/synthesis";
import { SuggestionList } from "@/shared/components/SuggestionList";

type WelcomeSuggestionsProps = {
  suggestions: WelcomeSuggestion[];
  onSelect: (suggestion: WelcomeSuggestion) => void;
};

export function WelcomeSuggestions({
  suggestions,
  onSelect,
}: WelcomeSuggestionsProps) {
  return (
    <SuggestionList
      suggestions={suggestions}
      onSelect={onSelect}
      className="suggestion-list--chat welcome-suggestions"
      itemClassName="welcome-suggestion-card"
      contentClassName="welcome-suggestion-content"
      headerClassName="welcome-suggestion-header"
      titleClassName="welcome-suggestion-title"
      badgeClassName="welcome-suggestion-badge"
      descriptionClassName="welcome-suggestion-desc"
    />
  );
}

