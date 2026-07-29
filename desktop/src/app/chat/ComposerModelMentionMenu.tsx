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
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { useCodexModelCatalog } from "@/global/settings/hooks/use-codex-model-catalog";
import { useClaudeCodeModelCatalog } from "@/global/settings/hooks/use-claude-code-model-catalog";
import {
  getStellaDisplayName,
  type CatalogModel,
} from "@/global/settings/lib/model-catalog";
import {
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_CODE_MODEL,
  listChatGptCatalogModels,
  type LiveCodexModel,
} from "@/global/settings/lib/engine-model-routing";
import type { ClaudeCodeCatalogModel } from "@/global/settings/hooks/use-claude-code-model-catalog";
import { useLlmCredentials } from "@/global/settings/hooks/use-llm-credentials";
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
  value: string;
  label: string;
  description: string;
  brand: string;
  provider: string;
  kind: "Engine" | "Model";
  searchTerms?: readonly string[];
  /** Available without a credential managed by useLlmCredentials. */
  available?: boolean;
};

export type RankedComposerModelMentionOption = ComposerModelMentionOption & {
  badge: "Current" | "Recent" | "Connected" | "Available" | "Engine" | "Model";
};

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

const TOKEN_CHARACTER_PATTERN = /[A-Za-z0-9._:/-]/;
const MAX_VISIBLE_OPTIONS = 16;

type ModelMentionPreferences = {
  modelOverrides: Record<string, string>;
  agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
  codexModel: string;
  claudeCodeModel: string;
};

let cachedModelMentionPreferences: ModelMentionPreferences | null = null;

function buildEngineOptions(
  preferences: ModelMentionPreferences | null,
): ComposerModelMentionOption[] {
  const chatGptModel = preferences?.codexModel || DEFAULT_CHATGPT_MODEL;
  const claudeCodeModel =
    preferences?.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL;
  return [
    {
      value: "chatgpt",
      label: "ChatGPT",
      description: `Uses your selected model · ${chatGptModel}`,
      brand: "openai",
      provider: "openai-codex",
      kind: "Engine",
      searchTerms: ["codex", "openai", "gpt", chatGptModel],
    },
    {
      value: "claude-code",
      label: "Claude Code",
      description: `Uses your selected model · ${claudeCodeModel}`,
      brand: "anthropic",
      provider: "claude-code",
      kind: "Engine",
      searchTerms: ["claude", "anthropic", claudeCodeModel],
    },
  ];
}

export function resolveCurrentModelMentionValue(
  preferences: ModelMentionPreferences | null,
): string | null {
  if (!preferences) return null;
  if (preferences.agentRuntimeEngine === "codex_cli") return "chatgpt";
  if (preferences.agentRuntimeEngine === "claude_code_local") {
    return "claude-code";
  }
  return (
    preferences.modelOverrides.orchestrator ??
    preferences.modelOverrides.general ??
    null
  );
}

function normalizeRecentMentionValue(value: string): string {
  if (value === "codex" || value === "codex-cli") return "chatgpt";
  if (value.startsWith("codex-cli/")) {
    return `chatgpt/${value.slice("codex-cli/".length)}`;
  }
  if (value.startsWith("openai-codex/")) {
    return `chatgpt/${value.slice("openai-codex/".length)}`;
  }
  return value;
}

/**
 * Finds the @token currently being edited. A trigger must begin at a word
 * boundary, so email addresses do not unexpectedly open the model menu.
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

function toChatGptOption(
  model: LiveCodexModel,
  available: boolean,
): ComposerModelMentionOption {
  return {
    value: `chatgpt/${model.id}`,
    label: model.displayName?.trim() || model.id,
    description: `ChatGPT · ${model.id}`,
    brand: "openai",
    provider: "openai-codex",
    kind: "Model",
    searchTerms: ["chatgpt", "codex", "openai", "gpt"],
    available,
  };
}

function toClaudeCodeOption(
  model: ClaudeCodeCatalogModel,
): ComposerModelMentionOption {
  return {
    value: `claude-code/${model.id}`,
    label: model.displayName?.trim() || model.id,
    description: `Claude Code · ${model.id}`,
    brand: "anthropic",
    provider: "claude-code",
    kind: "Model",
    searchTerms: ["claude", "anthropic", "claude code"],
    available: true,
  };
}

function toCatalogOption(model: CatalogModel): ComposerModelMentionOption {
  return {
    value: model.id,
    label:
      model.provider === "stella"
        ? getStellaDisplayName(model)
        : model.name || model.id,
    description: `${model.providerName} · ${model.id}`,
    brand: model.provider,
    provider: model.provider,
    kind: "Model",
    searchTerms: [model.provider, model.providerName],
    available:
      model.provider === "stella" ||
      model.provider === "local" ||
      model.runtimeCredentialless === true ||
      model.runtimeManagedAuth === true,
  };
}

export function buildComposerModelMentionOptions(args: {
  models: readonly CatalogModel[];
  codexModels: readonly LiveCodexModel[] | null;
  claudeCodeModels: readonly ClaudeCodeCatalogModel[] | null;
  preferences?: ModelMentionPreferences | null;
}): ComposerModelMentionOption[] {
  const options = buildEngineOptions(args.preferences ?? null);

  const liveChatGptModels = args.codexModels ?? [];
  const hasLiveChatGptCatalog = liveChatGptModels.length > 0;
  const chatGptModels = hasLiveChatGptCatalog
    ? liveChatGptModels
    : listChatGptCatalogModels(args.models).map((model) => ({
        id: model.modelId,
        displayName: model.name,
      }));
  options.push(
    ...chatGptModels.map((model) =>
      toChatGptOption(model, hasLiveChatGptCatalog),
    ),
  );

  if (args.claudeCodeModels) {
    options.push(...args.claudeCodeModels.map(toClaudeCodeOption));
  }

  options.push(
    ...args.models
      .filter(
        (model) =>
          model.provider !== "openai-codex" &&
          model.allowedForAudience !== false,
      )
      .map(toCatalogOption),
  );

  const seen = new Set<string>();
  return options.filter((option) => {
    const key = option.value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

type ModelMentionRankingSignals = {
  currentValue?: string | null;
  recentValues?: readonly string[];
  connectedProviders?: ReadonlySet<string>;
};

export function filterComposerModelMentionOptions(
  options: readonly ComposerModelMentionOption[],
  query: string,
  signals: ModelMentionRankingSignals = {},
): RankedComposerModelMentionOption[] {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedCurrent = signals.currentValue?.toLowerCase() ?? null;
  const recentOrder = new Map(
    (signals.recentValues ?? []).map((value, index) => [
      normalizeRecentMentionValue(value).toLowerCase(),
      index,
    ]),
  );
  const connectedProviders = signals.connectedProviders ?? new Set<string>();

  return options
    .map((option, index) => {
      const normalizedValue = option.value.toLowerCase();
      const current = normalizedValue === normalizedCurrent;
      const recentIndex = recentOrder.get(normalizedValue);
      const connected = connectedProviders.has(option.provider);
      const available = option.available === true;
      const searchable = [
        option.label,
        option.value,
        option.description,
        ...(option.searchTerms ?? []),
      ];
      const matchScore = normalizedQuery
        ? Math.max(
            ...searchable.map((text) =>
              scoreComposerModelMentionMatch(text, normalizedQuery),
            ),
          )
        : 1;
      const promoted =
        current ||
        (recentIndex !== undefined &&
          (connected || available || option.kind === "Engine")) ||
        connected ||
        available ||
        option.kind === "Engine";
      const priority =
        (current ? 10_000 : 0) +
        (recentIndex !== undefined ? 8_000 - recentIndex * 20 : 0) +
        (connected ? 4_000 : 0) +
        (available ? 2_000 : 0) +
        (option.kind === "Engine" ? 3_000 : 0);
      const badge: RankedComposerModelMentionOption["badge"] = current
        ? "Current"
        : recentIndex !== undefined && promoted
          ? "Recent"
          : connected
            ? "Connected"
            : available
              ? "Available"
              : option.kind;
      return {
        ...option,
        badge,
        index,
        matchScore,
        priority,
        promoted,
      };
    })
    .filter(
      (option) =>
        option.matchScore > 0 &&
        (normalizedQuery.length > 0 || option.promoted),
    )
    .sort((a, b) => {
      if (normalizedQuery) {
        if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;
        if (a.kind !== b.kind) return a.kind === "Engine" ? -1 : 1;
      }
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.index - b.index;
    })
    .slice(0, MAX_VISIBLE_OPTIONS);
}

export const ComposerModelMentionMenu = forwardRef<
  ComposerModelMentionMenuHandle,
  ComposerModelMentionMenuProps
>(function ComposerModelMentionMenu(
  { trigger, textarea, onSelect, onDismiss },
  ref,
) {
  const { allModels } = useModelCatalog();
  const codexCatalog = useCodexModelCatalog(true);
  const claudeCodeCatalog = useClaudeCodeModelCatalog(true);
  const credentials = useLlmCredentials();
  const [preferences, setPreferences] =
    useState<ModelMentionPreferences | null>(cachedModelMentionPreferences);
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
      cachedModelMentionPreferences = next;
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

  const connectedProviders = useMemo(() => {
    const next = new Set<string>(["stella", "local"]);
    for (const credential of credentials.apiKeys) {
      if (credential.status === "active") next.add(credential.provider);
    }
    for (const credential of credentials.oauthCredentials) {
      if (credential.status === "active") next.add(credential.provider);
    }
    if (
      claudeCodeCatalog.models !== null &&
      claudeCodeCatalog.models.length > 0
    ) {
      next.add("claude-code");
    }
    return next;
  }, [
    claudeCodeCatalog.models,
    credentials.apiKeys,
    credentials.oauthCredentials,
  ]);
  const currentValue = resolveCurrentModelMentionValue(preferences);

  const options = useMemo(
    () =>
      buildComposerModelMentionOptions({
        models: allModels,
        codexModels: codexCatalog.models,
        claudeCodeModels: claudeCodeCatalog.models,
        preferences,
      }),
    [allModels, claudeCodeCatalog.models, codexCatalog.models, preferences],
  );
  const filteredOptions = useMemo(
    () =>
      filterComposerModelMentionOptions(options, trigger.query, {
        currentValue,
        recentValues,
        connectedProviders,
      }),
    [connectedProviders, currentValue, options, recentValues, trigger.query],
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
      const desiredWidth = Math.max(320, Math.min(440, rect.width + 80));
      const width = Math.min(
        desiredWidth,
        window.innerWidth - viewportPadding * 2,
      );
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

  const loading =
    codexCatalog.loading ||
    claudeCodeCatalog.loading ||
    credentials.loading ||
    (allModels.length === 0 && filteredOptions.length <= 2);

  return createPortal(
    <div
      id="composer-model-mention-options"
      className="composer-model-mention-menu"
      data-model-mention-menu=""
      role="listbox"
      aria-label="Models and engines"
      style={position}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="composer-model-mention-menu__header">
        <span>Route to a model</span>
        <span className="composer-model-mention-menu__hint">
          ↑↓ select · Enter add
        </span>
      </div>
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
              <BrandIcon brand={option.brand} size={17} />
            </span>
            <span className="composer-model-mention-menu__copy">
              <span className="composer-model-mention-menu__label">
                {option.label}
              </span>
              <span className="composer-model-mention-menu__description">
                {option.description}
              </span>
            </span>
            <span className="composer-model-mention-menu__kind">
              {option.badge}
            </span>
          </button>
        ))}
        {filteredOptions.length === 0 && (
          <div className="composer-model-mention-menu__empty">
            No matching model
          </div>
        )}
        {loading && (
          <div className="composer-model-mention-menu__loading">
            Refreshing available models…
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
});
