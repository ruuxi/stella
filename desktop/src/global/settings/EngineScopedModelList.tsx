import { Check } from "@/ui/icons";
import "./EngineScopedModelList.css";

export type EngineScopedModelOption = {
  id: string;
  label: string;
  description?: string;
  unavailable?: boolean;
};

type EngineScopedModelListProps = {
  engineLabel: string;
  models: readonly EngineScopedModelOption[];
  value: string;
  onSelect: (modelId: string) => void;
  loading?: boolean;
  disabled?: boolean;
};

export function EngineScopedModelList({
  engineLabel,
  models,
  value,
  onSelect,
  loading = false,
  disabled = false,
}: EngineScopedModelListProps) {
  return (
    <div
      className="engine-scoped-model-list"
      aria-label={`${engineLabel} models`}
    >
      <div className="engine-scoped-model-list__head">
        <span>{engineLabel}</span>
      </div>
      <div className="engine-scoped-model-list__rows">
        {loading && models.length === 0 ? (
          <p>Loading {engineLabel} models…</p>
        ) : models.length === 0 ? (
          <p>No {engineLabel} models are available.</p>
        ) : (
          models.map((model) => {
            const selected = model.id === value;
            return (
              <button
                key={model.id}
                type="button"
                aria-pressed={selected}
                aria-disabled={model.unavailable || undefined}
                data-selected={selected || undefined}
                disabled={disabled || model.unavailable}
                onClick={() => onSelect(model.id)}
              >
                <span className="engine-scoped-model-list__text">
                  <span className="engine-scoped-model-list__name">
                    {model.label}
                  </span>
                  {model.description ? (
                    <span className="engine-scoped-model-list__description">
                      {model.description}
                    </span>
                  ) : null}
                </span>
                {selected ? <Check size={13} aria-hidden /> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
