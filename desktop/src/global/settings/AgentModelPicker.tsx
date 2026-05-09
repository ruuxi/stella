import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import { CompactStellaModelList } from "@/global/settings/CompactStellaModelList";
import { LocalRuntimeOptions } from "@/global/settings/LocalRuntimeOptions";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { getStellaDisplayName } from "@/global/settings/lib/model-catalog";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getConfigurableAgents,
  getDefaultModelOptionLabel,
  getModelDisplayLabel,
  getLocalModelDefaults,
  normalizeModelOverrides,
  type ModelDefaultEntry,
} from "@/global/settings/lib/model-defaults";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import "./AgentModelPicker.css";

type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  reasoningEfforts: Record<string, ReasoningEffort>;
  agentRuntimeEngine: "default" | "claude_code_local";
  maxAgentConcurrency: number;
};

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

const REASONING_EFFORT_OPTIONS: Array<{
  id: ReasoningEffort;
  label: string;
}> = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
];

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.id === value);
}

interface AgentModelPickerProps {
  /**
   * Called whenever the user finishes a real selection (model picked or
   * default chosen). Lets the sidebar popover close itself; the inline
   * Settings render leaves this undefined and stays mounted.
   */
  onSelected?: () => void;
  /** Optional className appended to the root element. */
  className?: string;
  /**
   * When true the picker mounts already expanded (shows the full provider
   * rail + local runtime options). Defaults to false: callers see just the
   * curated Stella presets and a "More options" toggle.
   */
  defaultExpanded?: boolean;
}

/**
 * Inline, no-popover model picker keyed off the orchestrator/general
 * segmented toggle at the top. Owns its own preference state so it can
 * drop into either the sidebar's `Models` popover or the Settings tab
 * without a wrapper.
 */
export function AgentModelPicker({
  onSelected,
  className,
  defaultExpanded = false,
}: AgentModelPickerProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const {
    models: stellaModels,
    defaults: stellaDefaultModels,
    groups,
    refresh,
    refreshing,
  } = useModelCatalog();

  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    null,
  );
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled && next) {
          setPreferences(next);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Failed to load model settings.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const modelDefaults = useMemo<ModelDefaultEntry[] | undefined>(() => {
    if (!preferences) return undefined;
    return getLocalModelDefaults(
      preferences.defaultModels,
      stellaDefaultModels,
    );
  }, [preferences, stellaDefaultModels]);

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

  const defaultModelMap = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const resolvedDefaultModelMap = useMemo(
    () => buildResolvedModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );

  const configurableAgents = useMemo(
    () => getConfigurableAgents(modelDefaults),
    [modelDefaults],
  );

  const overrides = useMemo<Record<string, string>>(() => {
    if (!preferences) return {};
    return normalizeModelOverrides(preferences.modelOverrides, defaultModelMap);
  }, [defaultModelMap, preferences]);

  const [activeAgent, setActiveAgent] = useState<string>("orchestrator");

  // Snap to the first available configurable agent if `orchestrator` is
  // somehow missing from the catalog. We don't auto-jump after the user has
  // picked a tab — only when the active agent isn't actually configurable.
  useEffect(() => {
    if (configurableAgents.length === 0) return;
    if (configurableAgents.some((agent) => agent.key === activeAgent)) return;
    setActiveAgent(configurableAgents[0].key);
  }, [activeAgent, configurableAgents]);

  const handleSelect = useCallback(
    async (value: string) => {
      if (!preferences || pendingAgent) return;
      const previousOverrides = { ...preferences.modelOverrides };
      const nextOverrides = { ...previousOverrides };
      if (value === "") {
        delete nextOverrides[activeAgent];
      } else {
        nextOverrides[activeAgent] = value;
      }
      setPendingAgent(activeAgent);
      setPreferences({ ...preferences, modelOverrides: nextOverrides });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            modelOverrides: nextOverrides,
          });
        if (saved) setPreferences(saved);
        setError(null);
        onSelected?.();
      } catch (caught) {
        setPreferences((current) =>
          current ? { ...current, modelOverrides: previousOverrides } : current,
        );
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to update model setting.",
        );
      } finally {
        setPendingAgent(null);
      }
    },
    [activeAgent, onSelected, pendingAgent, preferences],
  );

  const handleReasoningEffortSelect = useCallback(
    async (effort: ReasoningEffort) => {
      if (!preferences || pendingAgent) return;
      const previousReasoningEfforts = {
        ...(preferences.reasoningEfforts ?? {}),
      };
      const nextReasoningEfforts = {
        ...previousReasoningEfforts,
        [activeAgent]: effort,
      };
      setPendingAgent(activeAgent);
      setPreferences({
        ...preferences,
        reasoningEfforts: nextReasoningEfforts,
      });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            reasoningEfforts: nextReasoningEfforts,
          });
        if (saved) setPreferences(saved);
        setError(null);
        onSelected?.();
      } catch (caught) {
        setPreferences((current) =>
          current
            ? { ...current, reasoningEfforts: previousReasoningEfforts }
            : current,
        );
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to update reasoning effort.",
        );
      } finally {
        setPendingAgent(null);
      }
    },
    [activeAgent, onSelected, pendingAgent, preferences],
  );

  const ready = preferences !== null && modelDefaults !== undefined;
  const current = overrides[activeAgent] ?? "";
  const defaultLabel = ready
    ? getDefaultModelOptionLabel(
        activeAgent,
        defaultModelMap,
        resolvedDefaultModelMap,
        modelNamesById,
      )
    : "Default";
  const currentLabel = ready
    ? current
      ? getModelDisplayLabel(current, modelNamesById)
      : defaultLabel
    : "Loading…";
  const currentReasoningEffort =
    preferences?.reasoningEfforts?.[activeAgent] ?? "medium";

  return (
    <div
      className={["agent-model-picker", className].filter(Boolean).join(" ")}
    >
      <div className="agent-model-picker-header">
        <div className="agent-model-picker-toggle" role="tablist">
          {configurableAgents.length === 0
            ? null
            : configurableAgents.map((agent) => {
                const isActive = agent.key === activeAgent;
                return (
                  <button
                    key={agent.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="agent-model-picker-toggle-btn"
                    data-active={isActive || undefined}
                    onClick={() => setActiveAgent(agent.key)}
                    disabled={pendingAgent !== null}
                    title={agent.desc}
                  >
                    {agent.label}
                  </button>
                );
              })}
        </div>
        <button
          type="button"
          className="agent-model-picker-refresh"
          onClick={() => void refresh()}
          disabled={refreshing}
          title="Refresh model catalog"
          aria-label="Refresh model catalog"
        >
          <RefreshCw
            size={13}
            strokeWidth={1.75}
            data-spinning={refreshing || undefined}
          />
        </button>
      </div>

      {error ? (
        <p className="agent-model-picker-error" role="alert">
          {error}
        </p>
      ) : null}

      {expanded ? (
        <>
          <ProviderModelPanel
            value={current}
            defaultLabel={defaultLabel}
            currentLabel={currentLabel}
            reasoningEffort={currentReasoningEffort}
            reasoningEffortOptions={REASONING_EFFORT_OPTIONS}
            groups={groups}
            excludeModelId={STELLA_DEFAULT_MODEL}
            disabled={!ready || pendingAgent !== null}
            ariaLabel={`${activeAgent} model picker`}
            onSelect={handleSelect}
            onReasoningEffortSelect={(value) => {
              if (isReasoningEffort(value)) {
                void handleReasoningEffortSelect(value);
              }
            }}
          />
          <LocalRuntimeOptions />
        </>
      ) : (
        <CompactStellaModelList
          stellaModels={stellaModels}
          value={current}
          defaultLabel={defaultLabel}
          onSelect={handleSelect}
          disabled={!ready || pendingAgent !== null}
        />
      )}

      <button
        type="button"
        className="agent-model-picker-toggle-more"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span>{expanded ? "Less options" : "More options"}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          data-rotated={expanded || undefined}
        />
      </button>
    </div>
  );
}
