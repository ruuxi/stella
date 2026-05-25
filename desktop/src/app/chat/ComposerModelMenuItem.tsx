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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  getLocalModelDefaults,
  normalizeModelOverrides,
} from "@/global/settings/lib/model-defaults";
import { STELLA_STANDARD_MODEL } from "@/shared/stella-api";
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

type AgentRuntimeEngine = "default" | "claude_code_local" | "cursor_sdk";
type VisibleAgentRuntimeEngine = Exclude<AgentRuntimeEngine, "cursor_sdk">;

const ENGINE_OPTIONS: ReadonlyArray<{
  id: VisibleAgentRuntimeEngine;
  label: string;
}> = [
  { id: "default", label: "Stella" },
  { id: "claude_code_local", label: "Claude Code" },
];

type LocalModelPreferencesShape = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  assistantPropagatedAgents: string[];
  reasoningEfforts: Record<string, ReasoningEffort>;
  agentRuntimeEngine: AgentRuntimeEngine;
  cursorModel: string;
};

// Module-scope snapshot so re-opening the menu doesn't flash a loading
// state while the IPC roundtrip lands. Mirrors the cache the sidebar's
// `AgentModelPicker` keeps for the same reason.
let cachedLocalPreferences: LocalModelPreferencesShape | null = null;

function recordsEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const a = left ?? {};
  const b = right ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function localModelPreferencesEqual(
  left: LocalModelPreferencesShape | null,
  right: LocalModelPreferencesShape | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.agentRuntimeEngine === right.agentRuntimeEngine &&
    left.cursorModel === right.cursorModel &&
    recordsEqual(left.defaultModels, right.defaultModels) &&
    recordsEqual(left.modelOverrides, right.modelOverrides) &&
    recordsEqual(left.reasoningEfforts, right.reasoningEfforts) &&
    left.assistantPropagatedAgents.length ===
      right.assistantPropagatedAgents.length &&
    left.assistantPropagatedAgents.every(
      (key, index) => key === right.assistantPropagatedAgents[index],
    )
  );
}

function notifyLocalModelPreferencesChanged(skipReloadRef: { current: boolean }) {
  // This component already holds the optimistic/saved snapshot — reloading
  // from IPC on our own write only re-renders the open submenu.
  skipReloadRef.current = true;
  window.dispatchEvent(
    new CustomEvent("stella:local-model-preferences-changed"),
  );
}

export function ComposerModelMenuItem() {
  const {
    models: stellaModels,
    defaults: stellaDefaultModels,
    audience,
  } = useModelCatalog();

  const [preferences, setPreferencesRaw] =
    useState<LocalModelPreferencesShape | null>(() => cachedLocalPreferences);
  const pendingRef = useRef(false);
  const skipExternalReloadRef = useRef(false);

  const setPreferences = useCallback(
    (
      updater:
        | LocalModelPreferencesShape
        | null
        | ((
            prev: LocalModelPreferencesShape | null,
          ) => LocalModelPreferencesShape | null),
    ) => {
      setPreferencesRaw((current) => {
        const next =
          typeof updater === "function" ? updater(current) : updater;
        if (next) cachedLocalPreferences = next;
        if (localModelPreferencesEqual(current, next)) return current;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled && next) {
          const typed = next as LocalModelPreferencesShape;
          cachedLocalPreferences = typed;
          setPreferences(typed);
        }
      } catch {
        // Non-fatal: the submenu degrades to "Default" until the next
        // open attempt succeeds; AgentModelPicker surfaces any real
        // error in Settings.
      }
    };
    void load();
    const onExternalChange = () => {
      if (skipExternalReloadRef.current) {
        skipExternalReloadRef.current = false;
        return;
      }
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
  }, [setPreferences]);

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
          m.id !== STELLA_STANDARD_MODEL,
      ),
    [stellaModels],
  );

  const currentValue =
    overrides.orchestrator ?? overrides.general ?? "";
  const isDefaultSelected =
    !currentValue || currentValue === STELLA_STANDARD_MODEL;

  const trailingLabel = useMemo(() => {
    if (!preferences) return "Stella";
    // Claude Code engine ignores the Stella tier pick — surface the
    // actual model the bundled CLI runs (Opus 4.7) so the trigger row
    // reflects what's serving the response, not the engine name.
    if (preferences.agentRuntimeEngine === "claude_code_local") {
      return "Claude Opus 4.7";
    }
    if (isDefaultSelected) {
      // Friendly tier name only — the full default label is too long for an
      // inline trailing label.
      const resolved =
        resolvedDefaultModelMap.orchestrator ??
        defaultModelMap.orchestrator ??
        STELLA_STANDARD_MODEL;
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

  // The resolved tier name behind "Default" today — used as a trailing
  // chip on the Default row so users know what they're getting without
  // the longer default label.
  const defaultTierName = useMemo(() => {
    if (!preferences) return "Stella";
    const resolved =
      resolvedDefaultModelMap.orchestrator ??
      defaultModelMap.orchestrator ??
      STELLA_STANDARD_MODEL;
    return modelNamesById.get(resolved) ?? "Stella";
  }, [preferences, defaultModelMap, resolvedDefaultModelMap, modelNamesById]);

  const restricted = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  const currentReasoning: ReasoningEffort =
    preferences?.reasoningEfforts?.orchestrator ??
    preferences?.reasoningEfforts?.general ??
    "default";

  const handleSelectModel = useCallback(
    async (value: string) => {
      if (!preferences || pendingRef.current) return;
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

      pendingRef.current = true;
      const optimistic: LocalModelPreferencesShape = {
        ...preferences,
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: [],
      };
      setPreferences(optimistic);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            modelOverrides: nextOverrides,
            assistantPropagatedAgents: [],
          });
        if (saved) {
          setPreferences(saved as LocalModelPreferencesShape);
        }
        notifyLocalModelPreferencesChanged(skipExternalReloadRef);
      } catch {
        setPreferences({
          ...preferences,
          modelOverrides: previousOverrides,
          assistantPropagatedAgents: previousPropagated,
        });
      } finally {
        pendingRef.current = false;
      }
    },
    [preferences, setPreferences],
  );

  const handleReasoningSelect = useCallback(
    async (effort: ReasoningEffort) => {
      if (!preferences || pendingRef.current) return;
      const previous = { ...(preferences.reasoningEfforts ?? {}) };
      const next = { ...previous };
      if (effort === "default") {
        for (const key of ASSISTANT_WRITE_KEYS) delete next[key];
      } else {
        for (const key of ASSISTANT_WRITE_KEYS) next[key] = effort;
      }
      pendingRef.current = true;
      const optimistic: LocalModelPreferencesShape = {
        ...preferences,
        reasoningEfforts: next,
      };
      setPreferences(optimistic);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            reasoningEfforts: next,
          });
        if (saved) {
          setPreferences(saved as LocalModelPreferencesShape);
        }
        notifyLocalModelPreferencesChanged(skipExternalReloadRef);
      } catch {
        setPreferences({
          ...preferences,
          reasoningEfforts: previous,
        });
      } finally {
        pendingRef.current = false;
      }
    },
    [preferences, setPreferences],
  );

  const handleAdvanced = useCallback(() => {
    void router.navigate({ to: "/settings", search: { tab: "models" } });
  }, []);

  // Engine is a global runtime choice (Stella's own runner vs the
  // bundled Claude Code CLI). Mirrors the toggle in Settings → Models;
  // surfacing it here means the user doesn't have to leave the chat
  // composer to swap runtimes.
  const currentEngine: VisibleAgentRuntimeEngine =
    preferences?.agentRuntimeEngine === "claude_code_local"
      ? "claude_code_local"
      : "default";

  const handleEngineSelect = useCallback(
    async (next: VisibleAgentRuntimeEngine) => {
      if (!preferences || pendingRef.current) return;
      if (preferences.agentRuntimeEngine === next) return;
      const previous = preferences;
      const optimistic: LocalModelPreferencesShape = {
        ...preferences,
        agentRuntimeEngine: next,
      };
      setPreferences(optimistic);
      pendingRef.current = true;
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            agentRuntimeEngine: next,
          });
        if (saved) {
          setPreferences(saved as LocalModelPreferencesShape);
        }
        notifyLocalModelPreferencesChanged(skipExternalReloadRef);
      } catch {
        setPreferences(previous);
      } finally {
        pendingRef.current = false;
      }
    },
    [preferences, setPreferences],
  );

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
        <div className="composer-model-submenu__engine">
          <span className="composer-model-submenu__engine-label">Engine</span>
          <div
            className="composer-model-submenu__engine-segment"
            role="radiogroup"
            aria-label="Agent engine"
          >
            {ENGINE_OPTIONS.map((option) => {
              const selected = option.id === currentEngine;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-selected={selected || undefined}
                  className="composer-model-submenu__engine-btn"
                  disabled={!preferences}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleEngineSelect(option.id);
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <DropdownMenuSeparator />

        {currentEngine === "claude_code_local" ? (
          // Claude Code ships its own model — surface it as a single
          // locked row so the user can see what's actually serving the
          // response without offering tier choices that don't apply.
          <div
            className="composer-model-submenu__row composer-model-submenu__row--locked"
            data-selected
            aria-disabled
          >
            <span data-slot="dropdown-menu-item-icon">
              <Check size={14} strokeWidth={2} />
            </span>
            <span className="composer-model-submenu__name">
              Claude Opus 4.7
            </span>
          </div>
        ) : null}

        {currentEngine === "default" ? (
          <>
            <DropdownMenuItem
              data-selected={isDefaultSelected || undefined}
              onSelect={(event) => {
                event.preventDefault();
                void handleSelectModel("");
              }}
              className="composer-model-submenu__row"
            >
              <span data-slot="dropdown-menu-item-icon">
                {isDefaultSelected ? (
                  <Check size={14} strokeWidth={2} />
                ) : null}
              </span>
              <span className="composer-model-submenu__name">Default</span>
              <span className="composer-model-submenu__trail">
                {defaultTierName}
              </span>
            </DropdownMenuItem>

            {presets.length === 0 ? (
              <div className="composer-model-submenu__empty">
                Loading Stella models…
              </div>
            ) : (
              presets.map((model) => {
                const selected =
                  !isDefaultSelected && model.id === currentValue;
                const rowRestricted =
                  restricted &&
                  !selected &&
                  model.allowedForAudience === false;
                const upstreamLabel = getStellaSubtitle(model);
                return (
                  <DropdownMenuItem
                    key={model.id}
                    data-selected={selected || undefined}
                    disabled={rowRestricted}
                    title={
                      rowRestricted && restrictedPlanLabel
                        ? `Not available on the ${restrictedPlanLabel} plan`
                        : undefined
                    }
                    onSelect={(event) => {
                      event.preventDefault();
                      void handleSelectModel(model.id);
                    }}
                    className="composer-model-submenu__row"
                  >
                    <span data-slot="dropdown-menu-item-icon">
                      {selected ? (
                        <Check size={14} strokeWidth={2} />
                      ) : null}
                    </span>
                    <span className="composer-model-submenu__name">
                      {getStellaDisplayName(model)}
                    </span>
                    {upstreamLabel ? (
                      <span className="composer-model-submenu__trail">
                        {upstreamLabel}
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
                    ? `${restrictedPlanLabel} plan uses Stella's pick.`
                    : `Your plan uses Stella's pick.`}
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
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleAdvanced}>
          <span data-slot="dropdown-menu-item-icon">
            <Sliders size={14} strokeWidth={1.75} />
          </span>
          Use your own provider or key
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
