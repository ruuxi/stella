import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { BrandIcon } from "@/ui/brand-icon";
import {
  readRecentModels,
  recordRecentModel,
} from "@/global/settings/lib/recent-models";
import "./composer-model-mention-menu.css";

export type ComposerModelMentionTrigger = {
  start: number;
  end: number;
  query: string;
};

export type ComposerModelMentionOption = {
  value: "stella" | "chatgpt" | "claude-code" | "xai";
  label: string;
  brand: string;
  searchTerms: readonly string[];
};

export type RankedComposerModelMentionOption = ComposerModelMentionOption;

export type ComposerModelMentionMenuHandle = {
  /**
   * Returns true when the open menu consumed the key and the composer should
   * skip its normal Enter-to-send behavior.
   */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
};

type ComposerModelMentionMenuProps = {
  trigger: ComposerModelMentionTrigger;
  textarea: HTMLTextAreaElement | null;
  onSelect: (option: ComposerModelMentionOption) => void;
  onDismiss: () => void;
};

type EngineMentionPreferences = {
  agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
  modelOverrides: Record<string, string>;
};

const TOKEN_CHARACTER_PATTERN = /[A-Za-z0-9._-]/;

export const COMPOSER_ENGINE_MENTION_OPTIONS: readonly ComposerModelMentionOption[] =
  [
    {
      value: "stella",
      label: "Stella",
      brand: "stella",
      searchTerms: ["default", "native", "built in"],
    },
    {
      value: "chatgpt",
      label: "ChatGPT",
      brand: "openai",
      searchTerms: ["codex", "codex cli", "openai", "gpt"],
    },
    {
      value: "claude-code",
      label: "Claude Code",
      brand: "anthropic",
      searchTerms: ["claude", "anthropic"],
    },
    {
      value: "xai",
      label: "xAI",
      brand: "xai",
      searchTerms: ["grok", "grok 4.5"],
    },
  ];

let cachedEngineMentionPreferences: EngineMentionPreferences | null = null;

export function resolveCurrentModelMentionValue(
  preferences: EngineMentionPreferences | null,
): ComposerModelMentionOption["value"] | null {
  if (preferences?.agentRuntimeEngine === "default") {
    const selectedModel =
      preferences.modelOverrides.orchestrator ??
      preferences.modelOverrides.general ??
      "";
    return selectedModel === "xai/grok-4.5" ? "xai" : "stella";
  }
  if (preferences?.agentRuntimeEngine === "codex_cli") return "chatgpt";
  if (preferences?.agentRuntimeEngine === "claude_code_local") {
    return "claude-code";
  }
  return null;
}

function normalizeRecentMentionValue(value: string): string {
  if (value === "default") return "stella";
  if (value === "codex" || value === "codex-cli") return "chatgpt";
  if (value === "claude") return "claude-code";
  return value;
}

/**
 * Finds the @token currently being edited. A trigger must begin at a word
 * boundary, so email addresses do not unexpectedly open the engine menu.
 */
export function findComposerModelMentionTrigger(
  value: string,
  caret: number | null,
): ComposerModelMentionTrigger | null {
  if (caret === null || caret < 0 || caret > value.length) return null;

  let start = caret - 1;
  while (start >= 0 && TOKEN_CHARACTER_PATTERN.test(value[start])) {
    start -= 1;
  }
  if (start < 0 || value[start] !== "@") return null;
  if (start > 0 && !/\s|\(|\[|\{/.test(value[start - 1])) return null;

  let end = caret;
  while (end < value.length && TOKEN_CHARACTER_PATTERN.test(value[end])) {
    end += 1;
  }

  return {
    start,
    end,
    query: value.slice(start + 1, caret),
  };
}

export function applyComposerModelMention(
  value: string,
  trigger: ComposerModelMentionTrigger,
  mention: string,
): { value: string; caret: number } {
  const before = value.slice(0, trigger.start);
  const after = value.slice(trigger.end);
  const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
  const inserted = `@${mention}${needsTrailingSpace ? " " : ""}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, "");
}

/**
 * Small deterministic fuzzy scorer. Prefix and word-prefix matches dominate,
 * followed by substrings, then compact/subsequence matches for abbreviated
 * input such as "cld" → "Claude Code".
 */
export function scoreComposerModelMentionMatch(
  text: string,
  query: string,
): number {
  const haystack = normalizeSearchText(text);
  const needle = normalizeSearchText(query);
  if (!haystack || !needle) return 0;
  if (haystack === needle) return 1_200;
  if (haystack.startsWith(needle)) return 1_050 - needle.length;

  const wordIndex = haystack
    .split(/[^a-z0-9]+/)
    .findIndex((word) => word.startsWith(needle));
  if (wordIndex >= 0) return 950 - wordIndex * 4;

  const substringIndex = haystack.indexOf(needle);
  if (substringIndex >= 0) return 850 - Math.min(substringIndex, 120);

  const compactHaystack = compactSearchText(haystack);
  const compactNeedle = compactSearchText(needle);
  if (!compactNeedle) return 0;
  const compactIndex = compactHaystack.indexOf(compactNeedle);
  if (compactIndex >= 0) return 760 - Math.min(compactIndex, 120);

  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (
    let index = 0;
    index < compactHaystack.length && queryIndex < compactNeedle.length;
    index += 1
  ) {
    if (compactHaystack[index] !== compactNeedle[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = index;
    lastMatch = index;
    queryIndex += 1;
  }
  if (queryIndex !== compactNeedle.length) return 0;
  const span = lastMatch - firstMatch + 1;
  const gaps = span - compactNeedle.length;
  return Math.max(1, 520 - gaps * 12 - firstMatch * 3);
}

type EngineMentionRankingSignals = {
  currentValue?: string | null;
  recentValues?: readonly string[];
};

export function filterComposerModelMentionOptions(
  options: readonly ComposerModelMentionOption[],
  query: string,
  signals: EngineMentionRankingSignals = {},
): RankedComposerModelMentionOption[] {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedCurrent = signals.currentValue?.toLowerCase() ?? null;
  const recentOrder = new Map(
    (signals.recentValues ?? []).map((value, index) => [
      normalizeRecentMentionValue(value).toLowerCase(),
      index,
    ]),
  );

  return options
    .map((option, index) => {
      const normalizedValue = option.value.toLowerCase();
      const current = normalizedValue === normalizedCurrent;
      const recentIndex = recentOrder.get(normalizedValue);
      const searchable = [option.label, option.value, ...option.searchTerms];
      const matchScore = normalizedQuery
        ? Math.max(
            ...searchable.map((text) =>
              scoreComposerModelMentionMatch(text, normalizedQuery),
            ),
          )
        : 1;
      const priority =
        (current ? 10_000 : 0) +
        (recentIndex !== undefined ? 8_000 - recentIndex * 20 : 0);
      return {
        ...option,
        index,
        matchScore,
        priority,
      };
    })
    .filter((option) => option.matchScore > 0)
    .sort((a, b) => {
      if (normalizedQuery && a.matchScore !== b.matchScore) {
        return b.matchScore - a.matchScore;
      }
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.index - b.index;
    });
}

export const ComposerModelMentionMenu = forwardRef<
  ComposerModelMentionMenuHandle,
  ComposerModelMentionMenuProps
>(function ComposerModelMentionMenu(
  { trigger, textarea, onSelect, onDismiss },
  ref,
) {
  const [preferences, setPreferences] =
    useState<EngineMentionPreferences | null>(cachedEngineMentionPreferences);
  const [recentValues, setRecentValues] = useState(() => readRecentModels());
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    const loadPreferences = async () => {
      const next =
        await window.electronAPI?.system?.getLocalModelPreferences?.();
      if (cancelled || !next) return;
      cachedEngineMentionPreferences = next;
      setPreferences(next);
    };
    void loadPreferences().catch(() => undefined);
    const handlePreferencesChanged = () => {
      void loadPreferences().catch(() => undefined);
    };
    window.addEventListener(
      "stella:local-model-preferences-changed",
      handlePreferencesChanged,
    );
    return () => {
      cancelled = true;
      window.removeEventListener(
        "stella:local-model-preferences-changed",
        handlePreferencesChanged,
      );
    };
  }, []);

  const currentValue = resolveCurrentModelMentionValue(preferences);
  const filteredOptions = useMemo(
    () =>
      filterComposerModelMentionOptions(
        COMPOSER_ENGINE_MENTION_OPTIONS,
        trigger.query,
        {
          currentValue,
          recentValues,
        },
      ),
    [currentValue, recentValues, trigger.query],
  );
  const selectOption = useCallback(
    (option: ComposerModelMentionOption) => {
      setRecentValues(recordRecentModel(option.value));
      onSelect(option);
    },
    [onSelect],
  );
  const filteredOptionSignature = filteredOptions
    .map((option) => option.value)
    .join("\u0000");

  useEffect(() => {
    setActiveIndex(0);
  }, [filteredOptionSignature, trigger.query]);

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(0, filteredOptions.length - 1)),
    );
  }, [filteredOptions.length]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useLayoutEffect(() => {
    if (!textarea) return;
    const updatePosition = () => {
      const rect = textarea.getBoundingClientRect();
      const viewportPadding = 12;
      const width = Math.min(184, window.innerWidth - viewportPadding * 2);
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - width - viewportPadding,
      );
      setPosition({
        left,
        bottom: window.innerHeight - rect.top + 8,
        width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [textarea]);

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown(event) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (filteredOptions.length > 0) {
            setActiveIndex((current) => (current + 1) % filteredOptions.length);
          }
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (filteredOptions.length > 0) {
            setActiveIndex(
              (current) =>
                (current - 1 + filteredOptions.length) % filteredOptions.length,
            );
          }
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
          return true;
        }
        if (
          (event.key === "Enter" || event.key === "Tab") &&
          filteredOptions[activeIndex]
        ) {
          event.preventDefault();
          selectOption(filteredOptions[activeIndex]);
          return true;
        }
        return false;
      },
    }),
    [activeIndex, filteredOptions, onDismiss, selectOption],
  );

  if (!position) return null;

  return createPortal(
    <div
      id="composer-model-mention-options"
      className="composer-model-mention-menu"
      data-model-mention-menu=""
      role="listbox"
      aria-label="Engines"
      style={position}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="composer-model-mention-menu__options">
        {filteredOptions.map((option, index) => (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            id={`composer-model-mention-${index}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className="composer-model-mention-menu__option"
            data-active={index === activeIndex ? "" : undefined}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => selectOption(option)}
          >
            <span className="composer-model-mention-menu__icon">
              <BrandIcon brand={option.brand} size={14} />
            </span>
            <span className="composer-model-mention-menu__label">
              {option.label}
            </span>
          </button>
        ))}
        {filteredOptions.length === 0 && (
          <div className="composer-model-mention-menu__empty">
            No matching engine
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
});
