import { memo, useCallback, useMemo, useState } from "react";
import { Check, Lightbulb, RefreshCw, Search, Star } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  readEngineModelFavorites,
  sortByFavorites,
  toggleEngineModelFavorite,
} from "./engine-model-favorites";

export type EngineRuntimeReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const REASONING_OPTIONS: ReadonlyArray<{
  id: EngineRuntimeReasoningEffort;
  label: string;
}> = [
  { id: "default", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Max" },
];

export type EngineRuntimeModelOption = {
  id: string;
  label: string;
  subtitle?: string;
};

interface EngineRuntimeModelPanelProps {
  providerLabel: string;
  models: readonly EngineRuntimeModelOption[];
  loading?: boolean;
  disabled?: boolean;
  selectedModelId?: string;
  favoriteScope: string;
  onRefresh?: () => void;
  onSelectModel: (modelId: string) => void;
  /**
   * Current engine-wide thinking/effort level. When `onSelectReasoning` is
   * also provided, each model row shows a hover lightbulb that opens a
   * thinking menu. The effort is engine-global (one selected model), so the
   * lightbulb both applies the row's model and sets the effort.
   */
  reasoningEffort?: EngineRuntimeReasoningEffort;
  onSelectReasoning?: (
    modelId: string,
    effort: EngineRuntimeReasoningEffort,
  ) => void;
}

export function EngineRuntimeModelPanel({
  providerLabel,
  models,
  loading = false,
  disabled = false,
  selectedModelId,
  favoriteScope,
  onRefresh,
  onSelectModel,
  reasoningEffort,
  onSelectReasoning,
}: EngineRuntimeModelPanelProps) {
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() =>
    readEngineModelFavorites(favoriteScope),
  );

  const filteredModels = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const base = trimmed
      ? models.filter((model) => {
          const haystack =
            `${model.label} ${model.subtitle ?? ""} ${model.id}`.toLowerCase();
          return haystack.includes(trimmed);
        })
      : models;
    return sortByFavorites(base, favorites);
  }, [favorites, models, query]);

  const toggleFavorite = useCallback(
    (modelId: string) => {
      setFavorites(toggleEngineModelFavorite(favoriteScope, modelId));
    },
    [favoriteScope],
  );

  return (
    <div
      className="engine-runtime-model-panel"
      data-disabled={disabled || undefined}
      role="group"
      aria-label={`${providerLabel} models`}
    >
      <section className="engine-runtime-model-panel__pane">
        <header className="engine-runtime-model-panel__head">
          <span className="engine-runtime-model-panel__kicker">
            Tap a model
          </span>
          {onRefresh ? (
            <button
              type="button"
              className="engine-runtime-model-panel__refresh"
              disabled={loading || disabled}
              onClick={onRefresh}
            >
              <RefreshCw
                size={13}
                strokeWidth={1.75}
                data-spinning={loading || undefined}
              />
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          ) : null}
        </header>

        <div className="engine-runtime-model-panel__search">
          <Search size={13} strokeWidth={1.75} aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${providerLabel}…`}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            aria-label={`Search ${providerLabel} models`}
          />
        </div>

        <div className="engine-runtime-model-panel__list" role="listbox">
          {loading && models.length === 0 ? (
            <p className="engine-runtime-model-panel__empty">
              Loading {providerLabel} models…
            </p>
          ) : filteredModels.length === 0 ? (
            <p className="engine-runtime-model-panel__empty">
              {models.length === 0
                ? `No ${providerLabel} models available yet.`
                : "No models match."}
            </p>
          ) : (
            filteredModels.map((model) => (
              <EngineRuntimeModelRow
                key={model.id}
                model={model}
                selected={model.id === selectedModelId}
                favorite={favorites.includes(model.id)}
                disabled={disabled}
                onSelect={onSelectModel}
                onToggleFavorite={toggleFavorite}
                reasoningEffort={reasoningEffort}
                onSelectReasoning={onSelectReasoning}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

type EngineRuntimeModelRowProps = {
  model: EngineRuntimeModelOption;
  selected: boolean;
  favorite: boolean;
  disabled: boolean;
  onSelect: (modelId: string) => void;
  onToggleFavorite: (modelId: string) => void;
  reasoningEffort?: EngineRuntimeReasoningEffort;
  onSelectReasoning?: (
    modelId: string,
    effort: EngineRuntimeReasoningEffort,
  ) => void;
};

const EngineRuntimeModelRow = memo(function EngineRuntimeModelRow({
  model,
  selected,
  favorite,
  disabled,
  onSelect,
  onToggleFavorite,
  reasoningEffort,
  onSelectReasoning,
}: EngineRuntimeModelRowProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const showReasoning = Boolean(onSelectReasoning);
  return (
    <div
      className="engine-runtime-model-panel__row"
      data-reason-open={reasoningOpen || undefined}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className="engine-runtime-model-panel__model"
        data-selected={selected || undefined}
        disabled={disabled}
        onClick={() => onSelect(model.id)}
      >
        <span className="engine-runtime-model-panel__model-text">
          <span className="engine-runtime-model-panel__model-name">
            {model.label}
          </span>
          {model.subtitle ? (
            <span className="engine-runtime-model-panel__model-sub">
              {model.subtitle}
            </span>
          ) : null}
        </span>
        {selected ? (
          <Check size={13} className="engine-runtime-model-panel__check" />
        ) : null}
      </button>
      {showReasoning ? (
        <DropdownMenu open={reasoningOpen} onOpenChange={setReasoningOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="engine-runtime-model-panel__reason"
              data-active={
                (selected &&
                  reasoningEffort &&
                  reasoningEffort !== "default") ||
                undefined
              }
              data-open={reasoningOpen || undefined}
              aria-label="Thinking effort"
              title="Thinking effort"
              disabled={disabled}
              onClick={(event) => event.stopPropagation()}
            >
              <Lightbulb size={14} strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" sideOffset={6}>
            <DropdownMenuRadioGroup
              value={(selected ? reasoningEffort : undefined) ?? "default"}
              onValueChange={(value) =>
                onSelectReasoning?.(
                  model.id,
                  value as EngineRuntimeReasoningEffort,
                )
              }
            >
              {REASONING_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <button
        type="button"
        className="engine-runtime-model-panel__star"
        data-favorite={favorite || undefined}
        aria-pressed={favorite}
        aria-label={favorite ? "Remove favorite" : "Add favorite"}
        title={favorite ? "Remove favorite" : "Favorite — pin to top"}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite(model.id);
        }}
      >
        <Star size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
});
