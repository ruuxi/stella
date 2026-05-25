import { memo, useCallback, useMemo, useState } from "react";
import { RefreshCw, Search, Star } from "lucide-react";
import {
  readEngineModelFavorites,
  sortByFavorites,
  toggleEngineModelFavorite,
} from "./engine-model-favorites";

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
  favoriteScope: string;
  onRefresh?: () => void;
  onSelectModel: (modelId: string, anchor: HTMLElement) => void;
}

export function EngineRuntimeModelPanel({
  providerLabel,
  models,
  loading = false,
  disabled = false,
  favoriteScope,
  onRefresh,
  onSelectModel,
}: EngineRuntimeModelPanelProps) {
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() =>
    readEngineModelFavorites(favoriteScope),
  );

  const filteredModels = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const base = trimmed
      ? models.filter((model) => {
          const haystack = `${model.label} ${model.subtitle ?? ""} ${model.id}`.toLowerCase();
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
      <aside className="engine-runtime-model-panel__rail" aria-hidden>
        <div className="engine-runtime-model-panel__rail-item" data-active>
          <span className="engine-runtime-model-panel__rail-bar" data-on />
          <span className="engine-runtime-model-panel__rail-label">
            {providerLabel}
          </span>
        </div>
      </aside>

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
                favorite={favorites.includes(model.id)}
                disabled={disabled}
                onSelect={onSelectModel}
                onToggleFavorite={toggleFavorite}
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
  favorite: boolean;
  disabled: boolean;
  onSelect: (modelId: string, anchor: HTMLElement) => void;
  onToggleFavorite: (modelId: string) => void;
};

const EngineRuntimeModelRow = memo(function EngineRuntimeModelRow({
  model,
  favorite,
  disabled,
  onSelect,
  onToggleFavorite,
}: EngineRuntimeModelRowProps) {
  return (
    <div className="engine-runtime-model-panel__row">
      <button
        type="button"
        role="option"
        className="engine-runtime-model-panel__model"
        disabled={disabled}
        onClick={(event) => onSelect(model.id, event.currentTarget)}
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
      </button>
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
