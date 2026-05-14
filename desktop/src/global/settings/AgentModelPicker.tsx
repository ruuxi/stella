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
  getPlanLabel,
  isRestrictedModelOverrideAudience,
} from "@/shared/billing/audience";
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
  assistantPropagatedAgents: string[];
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
 *
 * Picking a non-Stella model on the Assistant tab ALSO auto-propagates
 * the same model to every other configurable agent — minus chronicle,
 * which is intentionally explicit-opt-in (it runs minute-cadence over
 * screen captures, and picking e.g. Claude Opus for "Assistant" should
 * not silently translate to "burn $20/hr summarizing OCR on Opus").
 * Propagated writes are tracked in `assistantPropagatedAgents` so
 * switching Assistant back to Stella cleans up only those writes and
 * never touches user-intentional per-agent picks.
 */
const ASSISTANT_AGENT_KEYS: readonly string[] = ["orchestrator", "general"];

/** Agent keys that must never receive Assistant-tab propagation. */
const ASSISTANT_PROPAGATE_EXCLUDE: ReadonlySet<string> = new Set([
  "chronicle",
]);

const isStellaModelId = (modelId: string): boolean =>
  modelId === "" || modelId.startsWith("stella/");

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

/**
 * Last-known local model preferences, used to seed `useState` so re-opening
 * the picker doesn't flash a loading state while the IPC roundtrip lands.
 * Mutated whenever the picker successfully loads or saves preferences.
 */
let cachedLocalPreferences: LocalModelPreferences | null = null;

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

  const [preferences, setPreferencesRaw] = useState<LocalModelPreferences | null>(
    () => cachedLocalPreferences,
  );
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mirror state writes into the module-level cache so re-mounting the
  // picker (Radix unmounts popover content on close) shows the last
  // selection immediately instead of flashing "Loading…".
  const setPreferences = useCallback(
    (
      updater:
        | LocalModelPreferences
        | null
        | ((
            prev: LocalModelPreferences | null,
          ) => LocalModelPreferences | null),
    ) => {
      setPreferencesRaw((current) => {
        const next =
          typeof updater === "function" ? updater(current) : updater;
        if (next) cachedLocalPreferences = next;
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
          cachedLocalPreferences = next;
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
      const previousOverrides = { ...preferences.modelOverrides };
      const previousPropagated = [
        ...(preferences.assistantPropagatedAgents ?? []),
      ];
      const nextOverrides = { ...previousOverrides };
      let nextPropagated: string[] = previousPropagated;

      if (activeAssistant) {
        // Rebuild propagation from scratch on every Assistant pick: first
        // unwind whatever the last propagation wrote (so switching from
        // Anthropic -> Stella cleans every previously-broadcasted agent),
        // then re-apply against the new pick. User-intentional per-agent
        // overrides are left alone because they were never in
        // `previousPropagated` to begin with.
        for (const propagatedKey of previousPropagated) {
          delete nextOverrides[propagatedKey];
        }

        for (const key of assistantWriteKeys) {
          if (value === "") {
            delete nextOverrides[key];
          } else {
            nextOverrides[key] = value;
          }
        }

        if (value !== "" && !isStellaModelId(value)) {
          // Broadcast to every other configurable agent that doesn't have
          // an explicit user-intentional override. Chronicle is excluded —
          // see ASSISTANT_PROPAGATE_EXCLUDE.
          const propagateTargets = configurableAgents
            .map((agent) => agent.key)
            .filter(
              (key) =>
                !ASSISTANT_PROPAGATE_EXCLUDE.has(key) &&
                !(assistantWriteKeys as readonly string[]).includes(key),
            );
          const written: string[] = [];
          for (const key of propagateTargets) {
            const hadManualOverride =
              previousOverrides[key] !== undefined &&
              !previousPropagated.includes(key);
            if (hadManualOverride) continue;
            nextOverrides[key] = value;
            written.push(key);
          }
          nextPropagated = written;
        } else {
          nextPropagated = [];
        }
      } else {
        // Single-agent path (Settings tabs other than Assistant). The user
        // is explicitly setting this agent, so remove it from the
        // propagated set — it's owned by them now.
        if (value === "") {
          delete nextOverrides[activeAgent];
        } else {
          nextOverrides[activeAgent] = value;
        }
        nextPropagated = previousPropagated.filter(
          (key) => key !== activeAgent,
        );
      }

      setPendingAgent(activeAgent);
      setPreferences({
        ...preferences,
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: nextPropagated,
      });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            modelOverrides: nextOverrides,
            assistantPropagatedAgents: nextPropagated,
          });
        if (saved) setPreferences(saved);
        // Let other listeners (notably the Memory tab's chronicle gate)
        // pick up the new override without remounting.
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
        setError(null);
        // Restricted-tier picks used to fire a toast here. The picker
        // now disables Stella-provider models that aren't available on
        // the user's plan up front, so reaching this path means the
        // selection is allowed and no toast is needed.
        onSelected?.();
      } catch (caught) {
        setPreferences((current) =>
          current
            ? {
                ...current,
                modelOverrides: previousOverrides,
                assistantPropagatedAgents: previousPropagated,
              }
            : current,
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
      configurableAgents,
      onSelected,
      pendingAgent,
      preferences,
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

  /**
   * On free / anonymous / Go plans the backend silently coerces any
   * non-default Stella-provider pick back to the recommended model.
   * Surface that up front by disabling those rows in the picker (the
   * default row + every BYOK provider stay enabled).
   */
  const restrictedStellaPicks = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  // Surface a one-liner when Assistant is routed through a non-Stella
  // provider but Chronicle (screen memory) is still pointing at Stella —
  // those minute-cadence ticks would otherwise silently keep eating the
  // user's Stella quota without them realizing.
  const chronicleOverride = overrides.chronicle ?? "";
  const showChronicleStillOnStellaNotice =
    activeAssistant &&
    !activeProviderSetting &&
    current !== "" &&
    !isStellaModelId(current) &&
    (chronicleOverride === "" || isStellaModelId(chronicleOverride));

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
              restrictStellaPicks={restrictedStellaPicks}
              restrictedPlanLabel={restrictedPlanLabel}
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
            restricted={restrictedStellaPicks}
            restrictedPlanLabel={restrictedPlanLabel}
            onUpgrade={() => {
              void router.navigate({ to: "/billing" });
              onSelected?.();
            }}
          />
        )}

        {showChronicleStillOnStellaNotice ? (
          <p className="agent-model-picker-chronicle-notice">
            Screen memory still uses Stella.{" "}
            <button
              type="button"
              className="agent-model-picker-chronicle-link"
              onClick={() => {
                void router.navigate({
                  to: "/settings",
                  search: { tab: "models" },
                });
                onSelected?.();
              }}
            >
              Pick a small model for Chronicle
            </button>{" "}
            to switch.
          </p>
        ) : null}
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
