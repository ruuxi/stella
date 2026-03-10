import { memo } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/shared/lib/utils";
import type { WelcomeSuggestion } from "@/app/onboarding/services/synthesis";
import "./suggestion-list.css";

const CATEGORY_LABELS: Record<WelcomeSuggestion["category"], string> = {
  cron: "Automation",
  skill: "Skill",
  app: "App",
};

type SuggestionListProps = {
  suggestions: WelcomeSuggestion[];
  onSelect: (suggestion: WelcomeSuggestion) => void;
  className?: string;
  itemClassName?: string;
  contentClassName?: string;
  headerClassName?: string;
  titleClassName?: string;
  badgeClassName?: string;
  descriptionClassName?: string;
  getItemProps?: (
    suggestion: WelcomeSuggestion,
  ) => ButtonHTMLAttributes<HTMLButtonElement>;
};

function SuggestionListView({
  suggestions,
  onSelect,
  className,
  itemClassName,
  contentClassName,
  headerClassName,
  titleClassName,
  badgeClassName,
  descriptionClassName,
  getItemProps,
}: SuggestionListProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className={cn("suggestion-list", className)}>
      {suggestions.map((suggestion) => {
        const itemProps = getItemProps?.(suggestion) ?? {};
        return (
          <button
            key={`${suggestion.category}:${suggestion.title}:${suggestion.prompt}`}
            type="button"
            className={cn("suggestion-list__card", itemClassName)}
            data-category={suggestion.category}
            onClick={() => onSelect(suggestion)}
            {...itemProps}
          >
            <div className={cn("suggestion-list__content", contentClassName)}>
              <div className={cn("suggestion-list__header", headerClassName)}>
                <span className={cn("suggestion-list__title", titleClassName)}>
                  {suggestion.title}
                </span>
                <span
                  className={cn("suggestion-list__badge", badgeClassName)}
                  data-category={suggestion.category}
                >
                  {CATEGORY_LABELS[suggestion.category]}
                </span>
              </div>
              <span
                className={cn(
                  "suggestion-list__description",
                  descriptionClassName,
                )}
              >
                {suggestion.description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export const SuggestionList = memo(SuggestionListView);
