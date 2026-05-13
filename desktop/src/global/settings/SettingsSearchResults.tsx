import { Fragment, useMemo, type ReactNode } from "react";
import { ArrowRight, Search } from "lucide-react";
import {
  expandedMatchTerms,
  searchSettings,
  type ScoredSettingsSearchEntry,
} from "@/global/settings/lib/settings-search-index";
import {
  SETTINGS_TABS,
  type SettingsTab,
} from "@/global/settings/settings-tabs";
import { useT } from "@/shared/i18n";

interface SettingsSearchResultsProps {
  query: string;
  onSelect: (result: ScoredSettingsSearchEntry) => void;
  onClear: () => void;
}

/**
 * Global "Search settings" results view. Replaces the active tab's
 * content while the search input has a value so users can find a
 * setting without first guessing which tab it lives in (Apple System
 * Settings / VS Code Settings model).
 *
 * The catalog is the single source of results — selecting an entry
 * jumps to its tab and scrolls the matching section into view.
 */
export function SettingsSearchResults({
  query,
  onSelect,
  onClear,
}: SettingsSearchResultsProps) {
  const t = useT();

  // Highlight against the full expanded match set, not just the user's
  // literal tokens, so typing "mute" visibly highlights "sound" and
  // "notification" in the results — that's the cue that tells the user
  // "your synonym got picked up".
  const highlightTerms = useMemo(() => expandedMatchTerms(query), [query]);
  const results = useMemo(() => searchSettings(query), [query]);
  const trimmedQuery = query.trim();

  if (results.length === 0) {
    return (
      <div className="settings-search-results settings-search-results--empty">
        <div className="settings-search-results-empty-icon" aria-hidden>
          <Search size={20} strokeWidth={1.5} />
        </div>
        <div className="settings-search-results-empty-title">
          No settings match &ldquo;{trimmedQuery}&rdquo;
        </div>
        <div className="settings-search-results-empty-body">
          Try a shorter or different word.{" "}
          <button
            type="button"
            className="settings-search-results-link"
            onClick={onClear}
          >
            Clear search
          </button>
          .
        </div>
      </div>
    );
  }

  return (
    <div
      className="settings-search-results"
      role="listbox"
      aria-label={`${results.length} result${results.length === 1 ? "" : "s"}`}
    >
      <div className="settings-search-results-header">
        {results.length} result{results.length === 1 ? "" : "s"} for{" "}
        <span className="settings-search-results-header-query">
          {trimmedQuery}
        </span>
      </div>
      <ul className="settings-search-results-list">
        {results.map((entry, index) => (
          <li key={`${entry.tab}:${entry.title}`} className="settings-search-result-item">
            <button
              type="button"
              role="option"
              aria-selected={index === 0}
              className="settings-search-result-button"
              onClick={() => onSelect(entry)}
            >
              <div className="settings-search-result-body">
                <div className="settings-search-result-title">
                  {highlightTokens(entry.title, highlightTerms)}
                </div>
                <div className="settings-search-result-desc">
                  {highlightTokens(entry.description, highlightTerms)}
                </div>
              </div>
              <div className="settings-search-result-meta">
                <span className="settings-search-result-tab">
                  {t(getTabLabelKey(entry.tab))}
                </span>
                <ArrowRight
                  size={13}
                  strokeWidth={1.85}
                  className="settings-search-result-arrow"
                  aria-hidden
                />
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function getTabLabelKey(tab: SettingsTab): string {
  return SETTINGS_TABS.find((entry) => entry.key === tab)?.labelKey ?? "";
}

/**
 * Wrap matching token spans in `<mark>` for visual hinting. Tokens are
 * matched case-insensitively without modifying the original casing of
 * the surrounding text.
 */
function highlightTokens(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text;

  // Sort longer terms first so "sign in" matches before "sign" when
  // both are present in the expansion set.
  const sorted = [...terms]
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return text;

  // Escape regex metacharacters so user input like "c++" doesn't crash.
  const pattern = sorted.map(escapeRegExp).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <mark key={index} className="settings-search-match">
          {part}
        </mark>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
