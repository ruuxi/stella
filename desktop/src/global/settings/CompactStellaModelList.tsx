import { useMemo } from "react";
import { Check } from "@/ui/icons";
import {
  getStellaDisplayName,
  getStellaSubtitle,
  type CatalogModel,
} from "@/global/settings/lib/model-catalog";
import "./CompactStellaModelList.css";

interface CompactStellaModelListProps {
  /** All Stella catalog models. */
  stellaModels: readonly CatalogModel[];
  /** Currently selected override id ("" means default). */
  value: string;
  /** Label rendered for the default-mode entry. */
  defaultLabel: string;
  /** Selection callback. Empty string ⇒ revert to default. */
  onSelect: (value: string) => void;
  disabled?: boolean;
  /** True while the Stella catalog is still being fetched (no data yet). */
  loading?: boolean;
  /** Non-null when the Stella catalog fetch failed. */
  error?: string | null;
  /** Re-run the Stella catalog fetch (used by the failed-state retry). */
  onRetry?: () => void;
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
 * page. Shows just the curated Stella preset modes (Stella Designer,
 * Stella Builder, …) — bare `stella/<mode>` ids — so the common case is one
 * click; every other provider/model lives behind the "More options" expansion.
 */
export function CompactStellaModelList({
  stellaModels,
  value,
  defaultLabel,
  onSelect,
  disabled = false,
  loading = false,
  error = null,
  onRetry,
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
          // Curated tier "modes" have a bare alias id (no "/"); real managed
          // models (stella/<provider>/<model>) live behind "More options".
          !model.modelId.includes("/"),
      ),
    [stellaModels],
  );

  const isDefaultSelected = !value;

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
        loading ? (
          <div className="compact-stella-list-empty">Loading Stella models…</div>
        ) : (
          <div className="compact-stella-list-empty compact-stella-list-empty--state">
            <span>
              {error
                ? "Couldn't load Stella models."
                : "No Stella models available."}
            </span>
            {onRetry ? (
              <button
                type="button"
                className="compact-stella-list-restricted-link"
                onClick={onRetry}
              >
                Retry
              </button>
            ) : null}
          </div>
        )
      ) : (
        presets.map((model) => {
          const selected = !isDefaultSelected && model.id === value;
          const subtitle = getStellaSubtitle(model);
          // `allowedForAudience` is the backend's per-audience truth
          // exposed through the Stella catalog endpoint.
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
              ? `${restrictedPlanLabel} plan uses Stella's pick.`
              : `Your plan uses Stella's pick.`}
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
