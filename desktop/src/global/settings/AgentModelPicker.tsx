import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import { CompactStellaModelList } from "@/global/settings/CompactStellaModelList";
import { LocalRuntimeOptions } from "@/global/settings/LocalRuntimeOptions";
import {
  ProviderOnlyPicker,
  type ProviderOption,
} from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import {
  coerceRealtimeVoiceProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceUnderlyingProvider,
} from "../../../../runtime/contracts/local-preferences";
import { Select } from "@/ui/select";
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
import {
  getModelRestrictionActionLabel,
  getModelRestrictionDescription,
  isRestrictedModelOverrideAudience,
} from "@/shared/billing/audience";
import { BYOK_TOAST_ACTION } from "@/shared/billing/byok-action";
import { showToast } from "@/ui/toast";
import { router } from "@/router";
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
  realtimeVoice: RealtimeVoicePreferences;
};

type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const REASONING_EFFORT_OPTIONS: Array<{
  id: ReasoningEffort;
  label: string;
}> = [
  { id: "default", label: "Default" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
];

const ASSISTANT_TARGET = "__assistant__";
const IMAGE_TARGET = "__image__";
const VOICE_TARGET = "__voice__";

/**
 * The Assistant tab in the sidebar picker writes to both the orchestrator
 * and general agent keys, since users overwhelmingly want them to move
 * together. Splitting them is available in Settings -> Models -> Advanced.
 */
const ASSISTANT_AGENT_KEYS: readonly string[] = ["orchestrator", "general"];

const DEFAULT_IMAGE_GENERATION: ImageGenerationPreferences = {
  provider: "stella",
};
const DEFAULT_REALTIME_VOICE: RealtimeVoicePreferences = {
  provider: "stella",
};

const IMAGE_PROVIDER_OPTIONS: readonly ProviderOption[] = [
  { key: "stella", label: "Stella", description: "Default. Picks the best image model for you." },
  { key: "openai", label: "OpenAI", description: "Uses your OpenAI account." },
  {
    key: "openrouter",
    label: "OpenRouter",
    description: "Routes image generation through your OpenRouter account.",
  },
  { key: "fal", label: "fal", description: "Uses your fal account." },
];

const VOICE_PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    key: "stella",
    label: "Stella",
    description: "Default. All OpenAI, xAI, and Inworld voices included — no API key needed.",
  },
  { key: "openai", label: "OpenAI", description: "Use your own OpenAI account." },
  { key: "xai", label: "xAI", description: "Use your own xAI account with Grok's Voice Agent." },
  { key: "inworld", label: "Inworld", description: "Use your own Inworld account." },
];

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.id === value);
}

function getModelPickerDisplayLabel(
  modelId: string,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  if (modelId.startsWith("local/")) {
    const localId = modelId.slice("local/".length);
    const slash = localId.indexOf("/");
    if (slash > 0) {
      const maybeBaseUrl = decodeURIComponent(localId.slice(0, slash));
      const customModel = localId.slice(slash + 1).trim();
      if (/^https?:\/\//i.test(maybeBaseUrl) && customModel) {
        return `Local ${customModel}`;
      }
    }
    return `Local ${localId}`;
  }
  return getModelDisplayLabel(modelId, modelNamesById);
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
  /**
   * Surface this picker is mounted on. The sidebar popover shows a lean
   * `Assistant | Image | Voice` tab strip and dual-writes Assistant to both
   * the orchestrator and general agent keys. The Settings page shows every
   * configurable agent as its own tab (orchestrator and general included
   * but no longer coupled) plus image + voice, and uses the same layout
   * (compact Stella presets, expandable to the full provider catalog) for
   * each.
   */
  surface?: "sidebar" | "settings";
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
  surface = "sidebar",
}: AgentModelPickerProps) {
  // The Settings page surfaces the full provider catalog inline (no
  // compact-vs-expanded toggle, no "Connect a provider" affordance to
  // discover): users land on Models specifically to manage providers, so
  // we treat the picker as permanently expanded there. The sidebar
  // popover keeps the compact-by-default behavior.
  const isSettings = surface === "settings";
  const [expandedState, setExpanded] = useState<boolean>(defaultExpanded);
  const expanded = isSettings ? true : expandedState;
  const {
    models: stellaModels,
    defaults: stellaDefaultModels,
    groups,
    refresh,
    refreshing,
    audience,
  } = useModelCatalog();

  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    null,
  );
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
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

  const overrides = useMemo<Record<string, string>>(() => {
    if (!preferences) return {};
    return normalizeModelOverrides(preferences.modelOverrides, defaultModelMap);
  }, [defaultModelMap, preferences]);

  /**
   * Sidebar: only Assistant/Image/Voice tabs render (Assistant dual-writes
   * orchestrator + general). Settings: every configurable agent gets its
   * own tab, so users can decouple orchestrator vs general (and tune the
   * rest) without leaving the same picker layout.
   */
  const configurableAgents = useMemo(
    () => getConfigurableAgents(modelDefaults),
    [modelDefaults],
  );
  const initialActiveAgent =
    surface === "settings"
      ? configurableAgents[0]?.key ?? "orchestrator"
      : ASSISTANT_TARGET;
  const [activeAgent, setActiveAgent] = useState<string>(initialActiveAgent);
  // Snap to a known agent key if the catalog loads after first render and
  // the initially-chosen key isn't in it (Settings surface only).
  useEffect(() => {
    if (surface !== "settings") return;
    if (configurableAgents.length === 0) return;
    if (
      activeAgent === IMAGE_TARGET ||
      activeAgent === VOICE_TARGET ||
      configurableAgents.some((entry) => entry.key === activeAgent)
    ) {
      return;
    }
    setActiveAgent(configurableAgents[0].key);
  }, [activeAgent, configurableAgents, surface]);

  const activeAssistant = activeAgent === ASSISTANT_TARGET;
  const activeImage = activeAgent === IMAGE_TARGET;
  const activeVoice = activeAgent === VOICE_TARGET;
  const activeProviderSetting = activeImage || activeVoice;

  /**
   * The sidebar Assistant tab writes to both orchestrator and general (and
   * reads from orchestrator with general as a fallback). Settings always
   * writes to a single agent key — even orchestrator and general are
   * separate tabs there.
   */
  const assistantWriteKeys = ASSISTANT_AGENT_KEYS;
  const canonicalAgentKey = activeAssistant
    ? ASSISTANT_AGENT_KEYS[0]
    : activeAgent;

  const handleSelect = useCallback(
    async (value: string) => {
      if (!preferences || pendingAgent) return;
      const writeKeys = activeAssistant ? assistantWriteKeys : [activeAgent];
      const previousOverrides = { ...preferences.modelOverrides };
      const nextOverrides = { ...previousOverrides };
      if (value === "") {
        for (const key of writeKeys) delete nextOverrides[key];
      } else {
        for (const key of writeKeys) nextOverrides[key] = value;
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
        // Picking a non-default model on a tier that's pinned to the
        // backend-chosen model is a no-op at request time (the Stella
        // provider silently coerces). Surface a toast so the user
        // understands their selection won't be honored on this plan —
        // BUT only when:
        //   1. the pick is a Stella-provider model (BYOK / OAuth picks
        //      via Anthropic/OpenAI/etc. run locally and aren't subject
        //      to Stella tier restrictions), and
        //   2. the pick actually resolves to a different upstream than
        //      what the audience would already get. Picking "Stella Light"
        //      on the Free plan is a no-op, not a restriction.
        const pickedModel = stellaModels.find((model) => model.id === value);
        const isStellaProviderPick = pickedModel?.provider === "stella";
        const pickedUpstream = pickedModel?.upstreamModel ?? "";
        const audienceUpstream =
          resolvedDefaultModelMap[canonicalAgentKey] ?? "";
        const resolvesToSameModel =
          pickedUpstream !== "" &&
          audienceUpstream !== "" &&
          pickedUpstream === audienceUpstream;
        if (
          value !== "" &&
          isStellaProviderPick &&
          !resolvesToSameModel &&
          isRestrictedModelOverrideAudience(audience)
        ) {
          const modelLabel = getModelDisplayLabel(value, modelNamesById);
          showToast({
            title: "Model not available on your plan",
            description: audience
              ? getModelRestrictionDescription({
                  audience,
                  modelLabel,
                  tense: "will",
                })
              : `${modelLabel} isn't available on your current plan. Stella will use its recommended model.`,
            variant: "error",
            duration: 8000,
            action: {
              label: audience
                ? getModelRestrictionActionLabel(audience)
                : "Upgrade",
              onClick: () => {
                void router.navigate({ to: "/billing" });
              },
            },
            secondaryAction: BYOK_TOAST_ACTION,
          });
        }
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
    [
      activeAgent,
      activeAssistant,
      assistantWriteKeys,
      audience,
      canonicalAgentKey,
      modelNamesById,
      onSelected,
      pendingAgent,
      preferences,
      resolvedDefaultModelMap,
      stellaModels,
    ],
  );

  const handleImageProviderSelect = useCallback(
    async (providerKey: string) => {
      if (!preferences || pendingAgent) return;
      const previousImageGeneration =
        preferences.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
      const nextImageGeneration: ImageGenerationPreferences =
        providerKey === "openai"
          ? { provider: "openai" }
          : providerKey === "openrouter"
            ? { provider: "openrouter" }
            : providerKey === "fal"
              ? { provider: "fal" }
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

  /**
   * Optimistic patch of just the `realtimeVoice` slice. Voice catalog
   * changes (voice id, speed, sub-family) are tiny and idempotent, so we
   * deliberately skip the pendingAgent gate that would flicker the whole
   * picker on every click. The caller passes the next slice and an
   * error label; we apply locally, write through IPC, and revert on
   * failure.
   */
  const patchRealtimeVoice = useCallback(
    async (
      next: RealtimeVoicePreferences,
      errorLabel: string,
    ): Promise<void> => {
      if (!preferences) return;
      const previous = preferences.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      setPreferences({ ...preferences, realtimeVoice: next });
      try {
        await window.electronAPI?.system?.setLocalModelPreferences?.({
          realtimeVoice: next,
        });
        setError(null);
      } catch (caught) {
        setPreferences((current) =>
          current ? { ...current, realtimeVoice: previous } : current,
        );
        setError(caught instanceof Error ? caught.message : errorLabel);
      }
    },
    [preferences],
  );

  const handleVoiceSelect = useCallback(
    (underlyingProvider: RealtimeVoiceUnderlyingProvider, voiceId: string) => {
      const previous =
        preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      void patchRealtimeVoice(
        {
          ...previous,
          voices: { ...(previous.voices ?? {}), [underlyingProvider]: voiceId },
        },
        "Failed to update voice setting.",
      );
    },
    [patchRealtimeVoice, preferences],
  );

  const handleInworldSpeedSelect = useCallback(
    (speed: number) => {
      const previous =
        preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      const clamped = Math.min(2.0, Math.max(0.5, speed));
      if (
        typeof previous.inworldSpeed === "number" &&
        Math.abs(previous.inworldSpeed - clamped) < 0.001
      ) {
        return;
      }
      void patchRealtimeVoice(
        { ...previous, inworldSpeed: clamped },
        "Failed to update Inworld speed.",
      );
    },
    [patchRealtimeVoice, preferences],
  );

  const handleStellaSubProviderSelect = useCallback(
    (subProvider: RealtimeVoiceUnderlyingProvider) => {
      const previous =
        preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      if (previous.stellaSubProvider === subProvider) return;
      void patchRealtimeVoice(
        { ...previous, stellaSubProvider: subProvider },
        "Failed to update voice family.",
      );
    },
    [patchRealtimeVoice, preferences],
  );

  const handleVoiceProviderSelect = useCallback(
    async (providerKey: string) => {
      if (!preferences || pendingAgent) return;
      const previous = preferences.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      // Preserve catalog choices (voice id, sub-family, speed) when
      // switching provider mode so a Stella → BYOK round-trip doesn't
      // wipe the user's selections. `model` is intentionally dropped:
      // the kernel re-selects the right default for the new provider.
      const next: RealtimeVoicePreferences = {
        provider: coerceRealtimeVoiceProvider(providerKey),
        ...(previous.voices ? { voices: previous.voices } : {}),
        ...(previous.stellaSubProvider
          ? { stellaSubProvider: previous.stellaSubProvider }
          : {}),
        ...(typeof previous.inworldSpeed === "number"
          ? { inworldSpeed: previous.inworldSpeed }
          : {}),
      };

      setPendingAgent(VOICE_TARGET);
      setPreferences({ ...preferences, realtimeVoice: next });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            realtimeVoice: next,
          });
        if (saved) setPreferences(saved);
        setError(null);
        onSelected?.();
      } catch (caught) {
        setPreferences((current) =>
          current ? { ...current, realtimeVoice: previous } : current,
        );
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to update voice setting.",
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
      const writeKeys = activeAssistant ? assistantWriteKeys : [activeAgent];
      const previousReasoningEfforts = {
        ...(preferences.reasoningEfforts ?? {}),
      };
      const nextReasoningEfforts = {
        ...previousReasoningEfforts,
      };
      if (effort === "default") {
        for (const key of writeKeys) delete nextReasoningEfforts[key];
      } else {
        for (const key of writeKeys) nextReasoningEfforts[key] = effort;
      }
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
    [
      activeAgent,
      activeAssistant,
      assistantWriteKeys,
      onSelected,
      pendingAgent,
      preferences,
    ],
  );

  const ready =
    preferences !== null &&
    (activeProviderSetting || modelDefaults !== undefined);
  const imagePreferences =
    preferences?.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
  const voicePreferences = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
  /**
   * Selected value for the active tab. For the assistant tab we prefer the
   * orchestrator key, falling back to general so a "split" Advanced setup
   * still shows something coherent. For image/voice we surface the provider
   * key directly (no model id) because those tabs are provider-only.
   */
  const current = activeAssistant
    ? overrides.orchestrator ?? overrides.general ?? ""
    : activeImage
      ? imagePreferences.provider
      : activeVoice
        ? voicePreferences.provider
        : overrides[activeAgent] ?? "";
  const defaultLabel =
    activeProviderSetting
      ? "Stella"
      : ready
        ? getDefaultModelOptionLabel(
            canonicalAgentKey,
            defaultModelMap,
            resolvedDefaultModelMap,
            modelNamesById,
          )
        : "Default";
  const currentLabel = activeProviderSetting
    ? IMAGE_PROVIDER_OPTIONS.find((entry) => entry.key === current)?.label ??
      VOICE_PROVIDER_OPTIONS.find((entry) => entry.key === current)?.label ??
      "Stella"
    : ready
      ? current
        ? getModelPickerDisplayLabel(current, modelNamesById)
        : defaultLabel
      : "Loading…";
  const currentReasoningEffort = activeAssistant
    ? preferences?.reasoningEfforts?.orchestrator ??
      preferences?.reasoningEfforts?.general ??
      "default"
    : preferences?.reasoningEfforts?.[activeAgent] ?? "default";
  const showFullPanel = expanded && !activeProviderSetting;

  const tabButton = (
    key: string,
    label: string,
    title: string,
    isActive: boolean,
  ) => (
    <button
      key={key}
      type="button"
      role="tab"
      aria-selected={isActive}
      className="agent-model-picker-toggle-btn"
      data-active={isActive || undefined}
      onClick={() => setActiveAgent(key)}
      disabled={pendingAgent !== null}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div
      className={["agent-model-picker", className].filter(Boolean).join(" ")}
    >
      <div className="agent-model-picker-header">
        <div
          className="agent-model-picker-toggle"
          role="tablist"
          aria-label="Surface"
          data-surface={surface}
        >
          {surface === "settings"
            ? [
                ...configurableAgents.map((agent) =>
                  tabButton(
                    agent.key,
                    agent.label,
                    agent.desc,
                    agent.key === activeAgent,
                  ),
                ),
                tabButton(
                  IMAGE_TARGET,
                  "Image",
                  "Image generation provider",
                  activeImage,
                ),
                tabButton(
                  VOICE_TARGET,
                  "Voice",
                  "Realtime voice provider",
                  activeVoice,
                ),
              ]
            : [
                tabButton(
                  ASSISTANT_TARGET,
                  "Assistant",
                  "Stella's main assistant",
                  activeAssistant,
                ),
                tabButton(
                  IMAGE_TARGET,
                  "Image",
                  "Image generation provider",
                  activeImage,
                ),
                tabButton(
                  VOICE_TARGET,
                  "Voice",
                  "Realtime voice provider",
                  activeVoice,
                ),
              ]}
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

      <div className="agent-model-picker-body">
      <div className="agent-model-picker-body">
        {error ? (
          <p className="agent-model-picker-error" role="alert">
            {error}
          </p>
        ) : null}

        {activeImage ? (
          <ProviderOnlyPicker
            providers={IMAGE_PROVIDER_OPTIONS}
            value={current || "stella"}
            onSelect={(key) => void handleImageProviderSelect(key)}
            disabled={!preferences || pendingAgent !== null}
            ariaLabel="Image provider"
          />
        ) : activeVoice ? (
          <>
            <ProviderOnlyPicker
              providers={VOICE_PROVIDER_OPTIONS}
              value={current || "stella"}
              onSelect={(key) => void handleVoiceProviderSelect(key)}
              disabled={!preferences || pendingAgent !== null}
              ariaLabel="Voice provider"
            />
            <VoiceCatalogPicker
              voiceProvider={voicePreferences.provider}
              stellaSubProvider={voicePreferences.stellaSubProvider}
              selectedVoices={voicePreferences.voices}
              inworldSpeed={voicePreferences.inworldSpeed}
              onSelectVoice={(underlyingProvider, voiceId) =>
                void handleVoiceSelect(underlyingProvider, voiceId)
              }
              onSelectStellaSubProvider={(sub) =>
                void handleStellaSubProviderSelect(sub)
              }
              onSelectInworldSpeed={(speed) =>
                void handleInworldSpeedSelect(speed)
              }
              disabled={!preferences || pendingAgent !== null}
            />
          </>
        ) : showFullPanel ? (
          <>
            <ProviderModelPanel
              value={current}
              defaultLabel={defaultLabel}
              currentLabel={currentLabel}
              groups={groups}
              excludeModelId={STELLA_DEFAULT_MODEL}
              disabled={!ready || pendingAgent !== null}
              ariaLabel="Assistant model picker"
              onSelect={handleSelect}
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
      </div>
      </div>

      {activeProviderSetting ? null : (
        <div className="agent-model-picker-footer">
          <div className="agent-model-picker-reasoning">
            <span>Reasoning</span>
            <Select
              value={currentReasoningEffort}
              onValueChange={(value) => {
                if (isReasoningEffort(value)) {
                  void handleReasoningEffortSelect(value);
                }
              }}
              disabled={pendingAgent !== null}
              aria-label="Reasoning effort"
              options={REASONING_EFFORT_OPTIONS.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
            />
          </div>
          {isSettings ? null : (
            <button
              type="button"
              className="agent-model-picker-toggle-more"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              title="Bring your own key or sign in to another provider"
            >
              <span>{expanded ? "Done" : "Connect a provider (BYOK)"}</span>
              <ChevronDown
                size={14}
                strokeWidth={1.75}
                data-rotated={expanded || undefined}
              />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
