/**
 * Body of the Discover card in the chat workspace strip. Renders
 * personalized suggestion prompts, capped at MAX_DISCOVER_ITEMS.
 * Cadence reports surface through the normal inline chat HTML artifact
 * path instead of occupying Discover slots.
 */
import { useCallback, useMemo, useState } from "react";
import { usePersonalizedCategories } from "@/app/home/categories";
import "./discover-list.css";

export const MAX_DISCOVER_ITEMS = 4;

// One-shot localStorage flag: flips true the first time the user
// invokes shuffle. Drives the small first-run hint dot on the
// shuffle button so the affordance is discoverable without
// becoming a permanent decoration.
const SHUFFLE_SEEN_STORAGE_KEY = "stella.discover.shuffleSeen";

const readShuffleSeen = (): boolean => {
  try {
    return window.localStorage.getItem(SHUFFLE_SEEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

type FlatSuggestion = {
  label: string;
  prompt: string;
  category: string;
};

// Interleave by category so any N-slice still spans Stella / Task /
// Skills / Schedule rather than clumping into one category at the top.
function interleaveByCategory(
  categories: ReadonlyArray<{
    label: string;
    options: ReadonlyArray<{ label: string; prompt: string }>;
  }>,
): FlatSuggestion[] {
  const cursors = categories.map(() => 0);
  const result: FlatSuggestion[] = [];
  let added = true;
  while (added) {
    added = false;
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      const idx = cursors[i];
      if (idx < category.options.length) {
        result.push({
          label: category.options[idx].label,
          prompt: category.options[idx].prompt,
          category: category.label,
        });
        cursors[i] = idx + 1;
        added = true;
      }
    }
  }
  return result;
}

export type DiscoverItem =
  {
    kind: "suggestion";
    key: string;
    label: string;
    category: string;
    prompt: string;
  };

export function useDiscoverItems(conversationId: string | null): {
  items: DiscoverItem[];
  canShuffle: boolean;
  shuffle: () => void;
  shuffleSeen: boolean;
} {
  const { categories } = usePersonalizedCategories(conversationId);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [shuffleSeen, setShuffleSeen] = useState<boolean>(readShuffleSeen);

  const flatSuggestions = useMemo(
    () => interleaveByCategory(categories),
    [categories],
  );

  const items = useMemo<DiscoverItem[]>(() => {
    if (flatSuggestions.length === 0) return [];

    const offset = shuffleSeed % flatSuggestions.length;
    const take = Math.min(MAX_DISCOVER_ITEMS, flatSuggestions.length);
    const suggestionItems: DiscoverItem[] = [];
    for (let i = 0; i < take; i++) {
      const suggestion = flatSuggestions[(offset + i) % flatSuggestions.length];
      suggestionItems.push({
        kind: "suggestion",
        key: `suggestion:${suggestion.category}:${suggestion.label}:${i}`,
        label: suggestion.label,
        category: suggestion.category,
        prompt: suggestion.prompt,
      });
    }
    return suggestionItems;
  }, [flatSuggestions, shuffleSeed]);

  const canShuffle = flatSuggestions.length > MAX_DISCOVER_ITEMS;

  const shuffle = useCallback(() => {
    setShuffleSeed((seed) => seed + MAX_DISCOVER_ITEMS);
    setShuffleSeen((seen) => {
      if (seen) return seen;
      try {
        window.localStorage.setItem(SHUFFLE_SEEN_STORAGE_KEY, "1");
      } catch {
        // Storage may be unavailable; the in-memory flag still hides
        // the dot for the rest of this session.
      }
      return true;
    });
  }, []);

  return { items, canShuffle, shuffle, shuffleSeen };
}

export function DiscoverList({
  items,
  onSuggestionClick,
  className,
}: {
  items: ReadonlyArray<DiscoverItem>;
  onSuggestionClick: (prompt: string) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={`discover-list${className ? ` ${className}` : ""}`}>
      {items.map((item) => {
        return (
          <li key={item.key} className="discover-list__item">
            <button
              type="button"
              className="discover-list__row discover-list__row--suggestion"
              onClick={() => onSuggestionClick(item.prompt)}
              title={item.prompt}
            >
              <span className="discover-list__label">{item.label}</span>
              <span className="discover-list__meta discover-list__meta--tag">
                {item.category}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
