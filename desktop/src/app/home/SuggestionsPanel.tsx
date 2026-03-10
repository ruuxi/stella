import { memo } from "react";
import type { WelcomeSuggestion } from "@/app/onboarding/services/synthesis";
import { SuggestionList } from "@/app/shared/SuggestionList";
import { DashboardCard } from "./DashboardCard";

type SuggestionsPanelProps = {
  suggestions: WelcomeSuggestion[];
  onSuggestionClick: (s: WelcomeSuggestion) => void;
};

function SuggestionsPanelView({
  suggestions,
  onSuggestionClick,
}: SuggestionsPanelProps) {
  return (
    <DashboardCard
      label="Suggestions"
      data-stella-label="Suggestions"
      data-stella-state={`${suggestions.length} items`}
    >
      <SuggestionList
        suggestions={suggestions}
        onSelect={onSuggestionClick}
        className="suggestion-list--home home-suggestions"
        itemClassName="home-suggestion-card"
        contentClassName="home-suggestion-content"
        headerClassName="home-suggestion-header"
        titleClassName="home-suggestion-title"
        badgeClassName="home-suggestion-badge"
        descriptionClassName="home-suggestion-desc"
        getItemProps={(suggestion) => ({
          "data-stella-action": suggestion.title,
        })}
      />
    </DashboardCard>
  );
}

export const SuggestionsPanel = memo(SuggestionsPanelView);
