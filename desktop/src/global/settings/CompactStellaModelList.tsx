import { useMemo } from "react";
import { Check } from "lucide-react";
import {
  getStellaDisplayName,
  getStellaSubtitle,
  type CatalogModel,
} from "@/global/settings/lib/model-catalog";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import "./CompactStellaModelList.css";

interface CompactStellaModelListProps {
  /** All Stella catalog models. */
  stellaModels: readonly CatalogModel[];
  /** Currently selected override id ("" means default). */
  value: string;
  /** Label rendered for the "default" entry (e.g. "Stella Recommended (currently …)"). */
  defaultLabel: string;
  /** Selection callback. Empty string ⇒ revert to default. */
  onSelect: (value: string) => void;
  disabled?: boolean;
  /**
   * When true the user's plan can't override the default Stella model
   * (anonymous, free, or Go). Non-default presets render disabled with
   * a small "{plan} plan" footer + upgrade affordance instead of
   * surfacing as clickable.
   */
  restricted?: boolean;
  restrictedPlanLabel?: string | null;
  onUpgrade?: () => void;
}

/**
 * Collapsed model picker used by both the sidebar popover and the Settings
 * page. Shows just the curated Stella preset modes (Stella Recommended,
 * Stella Designer, Stella Builder, …) so the common case is one click — every
 * other provider/model lives behind the "More options" expansion.
 */
export function CompactStellaModelList({
  stellaModels,
  value,
  defaultLabel,
  onSelect,
  disabled = false,
  restricted = false,
  restrictedPlanLabel,
  onUpgrade,
}: CompactStellaModelListProps) {
  const presets = useMemo(
    () =>
      stellaModels.filter(
        (model) =>
          model.provider === "stella" &&
          model.id.startsWith("stella/") &&
          !model.modelId.includes("/") &&
          model.id !== STELLA_DEFAULT_MODEL,
      ),
    [stellaModels],
  );

  const isDefaultSelected = !value || value === STELLA_DEFAULT_MODEL;

  return (
    <div
      className="compact-stella-list"
      role="listbox"
      aria-label="Stella models"
    >
      <button
        type="button"
        role="option"
        aria-selected={isDefaultSelected}
        className="compact-stella-list-item compact-stella-list-item--default"
        data-selected={isDefaultSelected || undefined}
        onClick={() => onSelect("")}
        disabled={disabled}
      >
        <span className="compact-stella-list-item-name">{defaultLabel}</span>
        {isDefaultSelected ? (
          <Check size={13} className="compact-stella-list-item-check" />
        ) : null}
      </button>
      {presets.length === 0 ? (
        <div className="compact-stella-list-empty">
          Loading Stella models…
        </div>
      ) : (
        presets.map((model) => {
          const selected = !isDefaultSelected && model.id === value;
          const subtitle = getStellaSubtitle(model);
          // `allowedForAudience` is the backend's per-audience
          // truth (undefined ⇒ allowed; only Stella-provider rows
          // ever carry the flag). The `restricted` prop is just a
          // local fast-path so we don't disable anything when the
          // audience hasn't been resolved yet.
          const rowRestricted =
            restricted && !selected && model.allowedForAudience === false;
          return (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={rowRestricted || undefined}
              className="compact-stella-list-item"
              data-selected={selected || undefined}
              data-restricted={rowRestricted || undefined}
              title={
                rowRestricted && restrictedPlanLabel
                  ? `Not available on the ${restrictedPlanLabel} plan`
                  : undefined
              }
              onClick={() => onSelect(model.id)}
              disabled={disabled || rowRestricted}
            >
              <span className="compact-stella-list-item-text">
                <span className="compact-stella-list-item-name">
                  {getStellaDisplayName(model)}
                </span>
                {subtitle ? (
                  <span className="compact-stella-list-item-sub">
                    {subtitle}
                  </span>
                ) : null}
              </span>
              {selected ? (
                <Check size={13} className="compact-stella-list-item-check" />
              ) : null}
            </button>
          );
        })
      )}
      {restricted ? (
        <div className="compact-stella-list-restricted">
          <span>
            {restrictedPlanLabel
              ? `${restrictedPlanLabel} plan uses Stella's recommended model.`
              : `Your plan uses Stella's recommended model.`}
          </span>
          {onUpgrade ? (
            <button
              type="button"
              className="compact-stella-list-restricted-link"
              onClick={onUpgrade}
            >
              Upgrade
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
