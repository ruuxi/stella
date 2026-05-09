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
import type { ProviderGroup } from "@/global/settings/lib/model-catalog";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import "./AgentModelPicker.css";

type ImageGenerationProvider = "stella" | "openai" | "openrouter" | "fal";
type ImageGenerationPreferences = {
  provider: ImageGenerationProvider;
  model?: string;
};

type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  reasoningEfforts: Record<string, ReasoningEffort>;
  agentRuntimeEngine: "default" | "claude_code_local";
  maxAgentConcurrency: number;
  imageGeneration: ImageGenerationPreferences;
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

const IMAGE_TARGET = "__image__";
const DEFAULT_IMAGE_GENERATION: ImageGenerationPreferences = {
  provider: "stella",
};

const DEFAULT_IMAGE_MODEL_BY_PROVIDER: Record<
  Exclude<ImageGenerationProvider, "stella">,
  string
> = {
  openai: "openai/gpt-image-1.5",
  openrouter: "openrouter/openai/gpt-image-2",
  fal: "fal/openai/gpt-image-2",
};

const IMAGE_PROVIDER_GROUPS: ProviderGroup[] = [
  {
    provider: "stella",
    providerName: "Stella",
    models: [
      {
        id: "stella",
        name: "Stella",
        provider: "stella",
        providerName: "Stella",
        modelId: "stella",
        source: "stella",
      },
    ],
  },
  {
    provider: "openai",
    providerName: "OpenAI",
    models: [
      {
        id: "openai/gpt-image-1.5",
        name: "GPT Image 1.5",
        provider: "openai",
        providerName: "OpenAI",
        modelId: "gpt-image-1.5",
        upstreamModel: "gpt-image-1.5",
        source: "local",
      },
      {
        id: "openai/gpt-image-1",
        name: "GPT Image 1",
        provider: "openai",
        providerName: "OpenAI",
        modelId: "gpt-image-1",
        upstreamModel: "gpt-image-1",
        source: "local",
      },
    ],
  },
  {
    provider: "openrouter",
    providerName: "OpenRouter",
    models: [
      {
        id: "openrouter/openai/gpt-image-2",
        name: "GPT Image 2",
        provider: "openrouter",
        providerName: "OpenRouter",
        modelId: "openai/gpt-image-2",
        upstreamModel: "openai/gpt-image-2",
        source: "local",
      },
    ],
  },
  {
    provider: "fal",
    providerName: "fal",
    models: [
      {
        id: "fal/openai/gpt-image-2",
        name: "GPT Image 2",
        provider: "fal",
        providerName: "fal",
        modelId: "openai/gpt-image-2",
        upstreamModel: "openai/gpt-image-2",
        source: "local",
      },
    ],
  },
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
  const activeImage = activeAgent === IMAGE_TARGET;

  // Snap to the first available configurable agent if `orchestrator` is
  // somehow missing from the catalog. We don't auto-jump after the user has
  // picked a tab — only when the active agent isn't actually configurable.
  useEffect(() => {
    if (activeImage) return;
    if (configurableAgents.length === 0) return;
    if (configurableAgents.some((agent) => agent.key === activeAgent)) return;
    setActiveAgent(configurableAgents[0].key);
  }, [activeAgent, activeImage, configurableAgents]);

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

  const handleImageSelect = useCallback(
    async (value: string) => {
      if (!preferences || pendingAgent) return;
      const previousImageGeneration =
        preferences.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
      const nextImageGeneration: ImageGenerationPreferences =
        value === "" || value === "stella"
          ? { provider: "stella" }
          : value.startsWith("openai/")
            ? { provider: "openai", model: value }
            : value.startsWith("openrouter/")
              ? { provider: "openrouter", model: value }
              : value.startsWith("fal/")
                ? { provider: "fal", model: value }
                : { provider: "stella" };

      setPendingAgent(IMAGE_TARGET);
      setPreferences({
        ...preferences,
        imageGeneration: nextImageGeneration,
      });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            imageGeneration: nextImageGeneration,
          });
        if (saved) setPreferences(saved);
        setError(null);
        onSelected?.();
      } catch (caught) {
        setPreferences((current) =>
          current
            ? { ...current, imageGeneration: previousImageGeneration }
            : current,
        );
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to update image setting.",
        );
      } finally {
        setPendingAgent(null);
      }
    },
    [onSelected, pendingAgent, preferences],
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

  const ready =
    preferences !== null && (activeImage || modelDefaults !== undefined);
  const imagePreferences =
    preferences?.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
  const current = activeImage
    ? imagePreferences.provider === "stella"
      ? ""
      : (imagePreferences.model ??
        DEFAULT_IMAGE_MODEL_BY_PROVIDER[imagePreferences.provider])
    : (overrides[activeAgent] ?? "");
  const defaultLabel =
    !activeImage && ready
      ? getDefaultModelOptionLabel(
          activeAgent,
          defaultModelMap,
          resolvedDefaultModelMap,
          modelNamesById,
        )
      : activeImage
        ? "Stella"
        : "Default";
  const imageModelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const group of IMAGE_PROVIDER_GROUPS) {
      for (const model of group.models) {
        next.set(model.id, model.name);
      }
    }
    next.set("stella", "Stella");
    return next;
  }, []);
  const currentLabel = activeImage
    ? current
      ? getModelDisplayLabel(current, imageModelNamesById)
      : "Stella"
    : ready
      ? current
        ? getModelDisplayLabel(current, modelNamesById)
        : defaultLabel
      : "Loading…";
  const currentReasoningEffort =
    preferences?.reasoningEfforts?.[activeAgent] ?? "medium";
  const showFullPanel = expanded || activeImage;

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
          <button
            type="button"
            role="tab"
            aria-selected={activeImage}
            className="agent-model-picker-toggle-btn"
            data-active={activeImage || undefined}
            onClick={() => setActiveAgent(IMAGE_TARGET)}
            disabled={pendingAgent !== null}
            title="Image generation provider"
          >
            Image
          </button>
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

      {showFullPanel ? (
        <>
          <ProviderModelPanel
            value={current}
            defaultLabel={defaultLabel}
            currentLabel={currentLabel}
            reasoningEffort={currentReasoningEffort}
            reasoningEffortOptions={REASONING_EFFORT_OPTIONS}
            groups={activeImage ? IMAGE_PROVIDER_GROUPS : groups}
            excludeModelId={activeImage ? undefined : STELLA_DEFAULT_MODEL}
            disabled={!ready || pendingAgent !== null}
            ariaLabel={
              activeImage
                ? "Image provider picker"
                : `${activeAgent} model picker`
            }
            onSelect={activeImage ? handleImageSelect : handleSelect}
            onReasoningEffortSelect={(value) => {
              if (isReasoningEffort(value)) {
                void handleReasoningEffortSelect(value);
              }
            }}
            showReasoning={!activeImage}
          />
          {activeImage ? null : <LocalRuntimeOptions />}
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

      {activeImage ? null : (
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
      )}
    </div>
  );
}
