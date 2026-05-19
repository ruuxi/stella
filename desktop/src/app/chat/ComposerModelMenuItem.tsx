/**
 * Model picker submenu used inside the composer `+` menu.
 *
 * Renders a `Model · <current name> ›` row whose hover/focus reveals
 * the curated Stella preset list, a Reasoning radio group, and an
 * `Advanced` escape hatch that opens Settings → Models for BYOK,
 * Image, and Voice providers.
 *
 * Writes use the same dual-write-to-orchestrator-and-general path that
 * `AgentModelPicker`'s Assistant tab uses (plus the propagation cleanup
 * for previous BYOK selections), so picking a Stella preset here always
 * unwinds any prior auto-propagation to other agents.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Cpu, Sliders } from "lucide-react";
import { router } from "@/router";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/ui/dropdown-menu";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import {
  getStellaDisplayName,
  getStellaSubtitle,
  type CatalogModel,
} from "@/global/settings/lib/model-catalog";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getDefaultModelOptionLabel,
  getLocalModelDefaults,
  normalizeModelOverrides,
} from "@/global/settings/lib/model-defaults";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import {
  getPlanLabel,
  isRestrictedModelOverrideAudience,
} from "@/shared/billing/audience";

type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const REASONING_OPTIONS: ReadonlyArray<{
  id: ReasoningEffort;
  label: string;
  title: string;
}> = [
  { id: "default", label: "Auto", title: "Default — let the model decide" },
  { id: "minimal", label: "Min", title: "Minimal reasoning" },
  { id: "low", label: "Low", title: "Low reasoning" },
  { id: "medium", label: "Med", title: "Medium reasoning" },
  { id: "high", label: "High", title: "High reasoning" },
  { id: "xhigh", label: "Max", title: "Extra reasoning" },
];

const ASSISTANT_WRITE_KEYS = ["orchestrator", "general"] as const;

type LocalModelPreferencesShape = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  assistantPropagatedAgents: string[];
  reasoningEfforts: Record<string, ReasoningEffort>;
};

// Module-scope snapshot so re-opening the menu doesn't flash a loading
// state while the IPC roundtrip lands. Mirrors the cache the sidebar's
// `AgentModelPicker` keeps for the same reason.
let cachedLocalPreferences: LocalModelPreferencesShape | null = null;

export function ComposerModelMenuItem() {
  const {
    models: stellaModels,
    defaults: stellaDefaultModels,
    audience,
  } = useModelCatalog();

  const [preferences, setPreferences] =
    useState<LocalModelPreferencesShape | null>(() => cachedLocalPreferences);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled && next) {
          cachedLocalPreferences = next as LocalModelPreferencesShape;
          setPreferences(cachedLocalPreferences);
        }
      } catch {
        // Non-fatal: the submenu degrades to "Default" until the next
        // open attempt succeeds; AgentModelPicker surfaces any real
        // error in Settings.
      }
    };
    void load();
    const onExternalChange = () => {
      void load();
    };
    window.addEventListener(
      "stella:local-model-preferences-changed",
      onExternalChange,
    );
    return () => {
      cancelled = true;
      window.removeEventListener(
        "stella:local-model-preferences-changed",
        onExternalChange,
      );
    };
  }, []);

  const modelDefaults = useMemo(
    () =>
      preferences
        ? getLocalModelDefaults(preferences.defaultModels, stellaDefaultModels)
        : undefined,
    [preferences, stellaDefaultModels],
  );
  const defaultModelMap = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const resolvedDefaultModelMap = useMemo(
    () => buildResolvedModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const overrides = useMemo(
    () =>
      preferences
        ? normalizeModelOverrides(preferences.modelOverrides, defaultModelMap)
        : {},
    [preferences, defaultModelMap],
  );
  const modelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const model of stellaModels) {
      const label =
        model.provider === "stella" ? getStellaDisplayName(model) : model.name;
      next.set(model.id, label);
      if (model.upstreamModel) next.set(model.upstreamModel, label);
    }
    return next;
  }, [stellaModels]);

  const presets = useMemo<CatalogModel[]>(
    () =>
      stellaModels.filter(
        (m) =>
          m.provider === "stella" &&
          m.id.startsWith("stella/") &&
          !m.modelId.includes("/") &&
          m.id !== STELLA_DEFAULT_MODEL,
      ),
    [stellaModels],
  );

  const currentValue =
    overrides.orchestrator ?? overrides.general ?? "";
  const isDefaultSelected =
    !currentValue || currentValue === STELLA_DEFAULT_MODEL;

  const trailingLabel = useMemo(() => {
    if (!preferences) return "Stella";
    if (isDefaultSelected) {
      // Friendly tier name only — "Stella Recommended (currently …)" is
      // too long for an inline trailing label.
      const resolved =
        resolvedDefaultModelMap.orchestrator ??
        defaultModelMap.orchestrator ??
        STELLA_DEFAULT_MODEL;
      return modelNamesById.get(resolved) ?? "Stella";
    }
    return modelNamesById.get(currentValue) ?? currentValue;
  }, [
    preferences,
    isDefaultSelected,
    currentValue,
    modelNamesById,
    defaultModelMap,
    resolvedDefaultModelMap,
  ]);

  const defaultRowLabel = useMemo(() => {
    if (!preferences) return "Stella Recommended";
    return getDefaultModelOptionLabel(
      "orchestrator",
      defaultModelMap,
      resolvedDefaultModelMap,
      modelNamesById,
    );
  }, [preferences, defaultModelMap, resolvedDefaultModelMap, modelNamesById]);

  const restricted = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  const currentReasoning: ReasoningEffort =
    preferences?.reasoningEfforts?.orchestrator ??
    preferences?.reasoningEfforts?.general ??
    "default";

  const handleSelectModel = useCallback(
    async (value: string) => {
      if (!preferences || pending) return;
      const previousOverrides = { ...preferences.modelOverrides };
      const previousPropagated = [
        ...(preferences.assistantPropagatedAgents ?? []),
      ];
      const nextOverrides = { ...previousOverrides };

      // Always unwind prior BYOK auto-propagation before applying the
      // new pick; presets surfaced here are Stella-only, so the new
      // propagation set is always empty.
      for (const key of previousPropagated) {
        delete nextOverrides[key];
      }
      for (const key of ASSISTANT_WRITE_KEYS) {
        if (value === "") delete nextOverrides[key];
        else nextOverrides[key] = value;
      }

      setPending(true);
      const optimistic: LocalModelPreferencesShape = {
        ...preferences,
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: [],
      };
      cachedLocalPreferences = optimistic;
      setPreferences(optimistic);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            modelOverrides: nextOverrides,
            assistantPropagatedAgents: [],
          });
        if (saved) {
          cachedLocalPreferences = saved as LocalModelPreferencesShape;
          setPreferences(cachedLocalPreferences);
        }
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
      } catch {
        const rolled: LocalModelPreferencesShape = {
          ...preferences,
          modelOverrides: previousOverrides,
          assistantPropagatedAgents: previousPropagated,
        };
        cachedLocalPreferences = rolled;
        setPreferences(rolled);
      } finally {
        setPending(false);
      }
    },
    [preferences, pending],
  );

  const handleReasoningSelect = useCallback(
    async (effort: ReasoningEffort) => {
      if (!preferences || pending) return;
      const previous = { ...(preferences.reasoningEfforts ?? {}) };
      const next = { ...previous };
      if (effort === "default") {
        for (const key of ASSISTANT_WRITE_KEYS) delete next[key];
      } else {
        for (const key of ASSISTANT_WRITE_KEYS) next[key] = effort;
      }
      setPending(true);
      const optimistic: LocalModelPreferencesShape = {
        ...preferences,
        reasoningEfforts: next,
      };
      cachedLocalPreferences = optimistic;
      setPreferences(optimistic);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            reasoningEfforts: next,
          });
        if (saved) {
          cachedLocalPreferences = saved as LocalModelPreferencesShape;
          setPreferences(cachedLocalPreferences);
        }
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
      } catch {
        const rolled: LocalModelPreferencesShape = {
          ...preferences,
          reasoningEfforts: previous,
        };
        cachedLocalPreferences = rolled;
        setPreferences(rolled);
      } finally {
        setPending(false);
      }
    },
    [preferences, pending],
  );

  const handleAdvanced = useCallback(() => {
    void router.navigate({ to: "/settings", search: { tab: "models" } });
  }, []);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span data-slot="dropdown-menu-item-icon">
          <Cpu size={14} strokeWidth={1.75} />
        </span>
        <span>Model</span>
        <span data-slot="dropdown-menu-trailing">
          <span>{trailingLabel}</span>
          <ChevronRight size={12} strokeWidth={1.75} />
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={4}
        alignOffset={-4}
        className="composer-model-submenu"
      >
        <DropdownMenuItem
          data-selected={isDefaultSelected || undefined}
          onSelect={(event) => {
            event.preventDefault();
            void handleSelectModel("");
          }}
          disabled={pending}
        >
          <span data-slot="dropdown-menu-item-icon">
            {isDefaultSelected ? (
              <Check size={14} strokeWidth={2} />
            ) : null}
          </span>
          <span className="composer-model-submenu__name">
            {defaultRowLabel}
          </span>
        </DropdownMenuItem>

        {presets.length === 0 ? (
          <div className="composer-model-submenu__empty">
            Loading Stella models…
          </div>
        ) : (
          presets.map((model) => {
            const selected = !isDefaultSelected && model.id === currentValue;
            const subtitle = getStellaSubtitle(model);
            const rowRestricted =
              restricted &&
              !selected &&
              model.allowedForAudience === false;
            return (
              <DropdownMenuItem
                key={model.id}
                data-selected={selected || undefined}
                disabled={pending || rowRestricted}
                title={
                  rowRestricted && restrictedPlanLabel
                    ? `Not available on the ${restrictedPlanLabel} plan`
                    : undefined
                }
                onSelect={(event) => {
                  event.preventDefault();
                  void handleSelectModel(model.id);
                }}
              >
                <span data-slot="dropdown-menu-item-icon">
                  {selected ? (
                    <Check size={14} strokeWidth={2} />
                  ) : null}
                </span>
                <span className="composer-model-submenu__name">
                  {getStellaDisplayName(model)}
                </span>
                {subtitle ? (
                  <span className="composer-model-submenu__sub">
                    {subtitle}
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}

        {restricted ? (
          <div className="composer-model-submenu__restricted">
            <span>
              {restrictedPlanLabel
                ? `${restrictedPlanLabel} plan uses Stella's recommended model.`
                : `Your plan uses Stella's recommended model.`}
            </span>
            <button
              type="button"
              className="composer-model-submenu__upgrade"
              onClick={() => {
                void router.navigate({ to: "/billing" });
              }}
            >
              Upgrade
            </button>
          </div>
        ) : null}

        <DropdownMenuSeparator />
        <div className="composer-model-submenu__reasoning">
          <span className="composer-model-submenu__reasoning-label">
            Reasoning
          </span>
          <div
            className="composer-model-submenu__reasoning-segment"
            role="radiogroup"
            aria-label="Reasoning effort"
          >
            {REASONING_OPTIONS.map((option) => {
              const selected = option.id === currentReasoning;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-selected={selected || undefined}
                  className="composer-model-submenu__reasoning-btn"
                  disabled={pending}
                  title={option.title}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleReasoningSelect(option.id);
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleAdvanced}>
          <span data-slot="dropdown-menu-item-icon">
            <Sliders size={14} strokeWidth={1.75} />
          </span>
          Advanced (Image, Voice, BYOK)…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
