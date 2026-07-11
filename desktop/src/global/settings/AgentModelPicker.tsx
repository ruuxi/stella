import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "@/ui/icons";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import {
  EngineScopedModelList,
  type EngineScopedModelOption,
} from "@/global/settings/EngineScopedModelList";
import {
  ProviderOnlyPicker,
  type ProviderOption,
} from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import {
  coerceRealtimeVoiceProvider,
  type ReadAloudVoiceProvider,
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
import {
  getPlanLabel,
  isRestrictedModelOverrideAudience,
} from "@/global/billing/audience";
import { router } from "@/router";
import { openEngineDisplayTab } from "@/features/workspace-display/default-tabs";
import {
  findOauthCredential,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import {
  buildEngineReasoningPatch,
  buildEngineRoutingPatch,
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_CODE_MODEL,
  fromOpenAiCodexModelId,
  listChatGptCatalogModels,
  OPENAI_CODEX_PROVIDER,
  type ModelPickerEngine,
} from "@/global/settings/lib/engine-model-routing";
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
  agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
  codexModel: string;
  codexReasoningEffort: ReasoningEffort;
  claudeCodeModel: string;
  claudeCodeReasoningEffort: ReasoningEffort;
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
const ENGINE_PENDING_TARGET = "__engine__";

const ENGINE_OPTIONS: ReadonlyArray<{
  id: ModelPickerEngine;
  label: string;
}> = [
  { id: "default", label: "Stella" },
  { id: "codex_cli", label: "ChatGPT" },
  { id: "claude_code_local", label: "Claude Code" },
];

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
const ASSISTANT_PROPAGATE_EXCLUDE: ReadonlySet<string> = new Set(["chronicle"]);

const isStellaModelId = (modelId: string): boolean =>
  modelId === "" || modelId.startsWith("stella/");

const DEFAULT_IMAGE_GENERATION: ImageGenerationPreferences = {
  provider: "stella",
};
const DEFAULT_REALTIME_VOICE: RealtimeVoicePreferences = {
  provider: "stella",
};

const IMAGE_PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    key: "stella",
    label: "Stella",
    description: "Default. Picks the best image model for you.",
  },
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
    description:
      "Default. All OpenAI, xAI, and Inworld voices included — no API key needed.",
  },
  {
    key: "openai",
    label: "OpenAI",
    description: "Use your own OpenAI account.",
  },
  {
    key: "xai",
    label: "xAI",
    description: "Use your own xAI account with Grok's Voice Agent.",
  },
  {
    key: "inworld",
    label: "Inworld",
    description: "Use your own Inworld account.",
  },
];

/**
 * Last-known local model preferences, used to seed `useState` so re-opening
 * the picker doesn't flash a loading state while the IPC roundtrip lands.
 * Mutated whenever the picker successfully loads or saves preferences.
 */
let cachedLocalPreferences: LocalModelPreferences | null = null;

/** Intent-hover warm: start the preferences IPC before the popover opens. */
export function warmAgentModelPickerCache(): void {
  if (cachedLocalPreferences) return;
  void window.electronAPI?.system
    ?.getLocalModelPreferences?.()
    .then((next) => {
      if (next) cachedLocalPreferences = next;
    })
    .catch(() => undefined);
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.id === value);
}

/** Friendly names for Claude Code CLI model aliases. */
const CLAUDE_CODE_ALIAS_LABELS: Record<string, string> = {
  default: "Default",
  best: "Best",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opusplan: "Opus Plan",
  "sonnet[1m]": "Sonnet · 1M",
  "opus[1m]": "Opus · 1M",
};

function getModelPickerDisplayLabel(
  modelId: string,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  if (modelId.startsWith("claude-code/")) {
    const engineModel = modelId.slice("claude-code/".length);
    return `Claude Code · ${CLAUDE_CODE_ALIAS_LABELS[engineModel] ?? engineModel}`;
  }
  if (modelId.startsWith("codex-cli/")) {
    return `ChatGPT · ${modelId.slice("codex-cli/".length)}`;
  }
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
   * Surface this picker is mounted on. The sidebar popover shows a lean
   * `Assistant | Image | Voice` tab strip and dual-writes Assistant to both
   * the orchestrator and general agent keys. The Settings page shows every
   * configurable agent as its own tab (orchestrator and general included
   * but no longer coupled) plus image + voice, and uses the same layout
   * with the same engine-scoped model catalog for each.
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
  surface = "sidebar",
}: AgentModelPickerProps) {
  const {
    allModels,
    defaults: stellaDefaultModels,
    groups,
    refresh,
    refreshing,
    audience,
  } = useModelCatalog();

  const [preferences, setPreferencesRaw] =
    useState<LocalModelPreferences | null>(() => cachedLocalPreferences);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claudeCodeModels, setClaudeCodeModels] = useState<
    EngineScopedModelOption[] | null
  >(null);
  const [claudeCodeModelsLoading, setClaudeCodeModelsLoading] = useState(false);
  const credentials = useLlmCredentials();

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
        const next = typeof updater === "function" ? updater(current) : updater;
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
  }, [setPreferences]);

  const loadClaudeCodeModels = useCallback(async () => {
    if (claudeCodeModelsLoading) return;
    setClaudeCodeModelsLoading(true);
    try {
      const result = await window.electronAPI?.system?.listClaudeCodeModels?.();
      setClaudeCodeModels(
        (result?.models ?? []).map((model) => ({
          id: model.id,
          label: model.displayName || model.id,
          description: model.description,
        })),
      );
    } catch (caught) {
      setClaudeCodeModels([]);
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to load Claude Code models.",
      );
    } finally {
      setClaudeCodeModelsLoading(false);
    }
  }, [claudeCodeModelsLoading]);

  useEffect(() => {
    if (
      preferences?.agentRuntimeEngine === "claude_code_local" &&
      claudeCodeModels === null &&
      !claudeCodeModelsLoading
    ) {
      void loadClaudeCodeModels();
    }
  }, [
    claudeCodeModels,
    claudeCodeModelsLoading,
    loadClaudeCodeModels,
    preferences?.agentRuntimeEngine,
  ]);

  const modelDefaults = useMemo<ModelDefaultEntry[] | undefined>(() => {
    if (!preferences) return undefined;
    return getLocalModelDefaults(
      preferences.defaultModels,
      stellaDefaultModels,
    );
  }, [preferences, stellaDefaultModels]);

  // Labels come from the FULL merged catalog so BYOK / local override ids
  // (openrouter/…, anthropic/…, local/…) render their display names too.
  const modelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const model of allModels) {
      const label =
        model.provider === "stella" ? getStellaDisplayName(model) : model.name;
      next.set(model.id, label);
      if (model.upstreamModel) next.set(model.upstreamModel, label);
    }
    return next;
  }, [allModels]);

  const chatGptCatalogModels = useMemo(
    () => listChatGptCatalogModels(allModels),
    [allModels],
  );
  const chatGptModels = useMemo<EngineScopedModelOption[]>(
    () =>
      chatGptCatalogModels.map((model) => ({
        id: model.modelId,
        label: model.name || model.modelId,
        description: model.modelId,
      })),
    [chatGptCatalogModels],
  );
  const chatGptModelIds = useMemo(
    () => new Set(chatGptModels.map((model) => model.id)),
    [chatGptModels],
  );
  const savedChatGptOverride = preferences
    ? fromOpenAiCodexModelId(
        preferences.modelOverrides.orchestrator ??
          preferences.modelOverrides.general ??
          "",
      )
    : null;
  const selectedChatGptModel =
    (savedChatGptOverride && chatGptModelIds.has(savedChatGptOverride)
      ? savedChatGptOverride
      : null) ??
    (preferences?.codexModel && chatGptModelIds.has(preferences.codexModel)
      ? preferences.codexModel
      : null) ??
    (chatGptModelIds.has(DEFAULT_CHATGPT_MODEL)
      ? DEFAULT_CHATGPT_MODEL
      : chatGptModels[0]?.id) ??
    DEFAULT_CHATGPT_MODEL;
  const selectedClaudeCodeModel =
    preferences?.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL;

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
    return normalizeModelOverrides(preferences.modelOverrides);
  }, [preferences]);

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
      ? (configurableAgents[0]?.key ?? "orchestrator")
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
      setPreferences,
    ],
  );

  const commitEngineSelection = useCallback(
    async (engine: ModelPickerEngine, modelId?: string): Promise<boolean> => {
      if (!preferences || pendingAgent) return false;
      const previous = preferences;
      setPendingAgent(ENGINE_PENDING_TARGET);
      setError(null);
      try {
        if (
          engine === "codex_cli" &&
          !findOauthCredential(
            credentials.oauthCredentials,
            OPENAI_CODEX_PROVIDER,
          )
        ) {
          await credentials.loginOAuth(OPENAI_CODEX_PROVIDER, {
            announceConnection: false,
          });
        }

        const patch = buildEngineRoutingPatch(
          preferences,
          engine,
          modelId,
        ) as Partial<LocalModelPreferences>;
        const optimistic = { ...preferences, ...patch };
        setPreferences(optimistic);
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        if (saved) setPreferences(saved);
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
        return true;
      } catch (caught) {
        setPreferences(previous);
        setError(
          caught instanceof Error && caught.message.trim()
            ? caught.message
            : engine === "codex_cli"
              ? "Failed to connect ChatGPT."
              : "Failed to update the engine.",
        );
        return false;
      } finally {
        setPendingAgent(null);
      }
    },
    [credentials, pendingAgent, preferences, setPreferences],
  );

  const handleEngineChange = useCallback(
    async (engine: ModelPickerEngine) => {
      if (!preferences || engine === preferences.agentRuntimeEngine) return;
      if (engine === "claude_code_local" && claudeCodeModels === null) {
        void loadClaudeCodeModels();
      }
      await commitEngineSelection(
        engine,
        engine === "codex_cli"
          ? selectedChatGptModel
          : engine === "claude_code_local"
            ? selectedClaudeCodeModel
            : undefined,
      );
    },
    [
      claudeCodeModels,
      commitEngineSelection,
      loadClaudeCodeModels,
      preferences,
      selectedChatGptModel,
      selectedClaudeCodeModel,
    ],
  );

  const handleEngineModelSelect = useCallback(
    async (modelId: string) => {
      if (!preferences) return;
      const saved = await commitEngineSelection(
        preferences.agentRuntimeEngine,
        modelId,
      );
      if (saved) onSelected?.();
    },
    [commitEngineSelection, onSelected, preferences],
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
    [onSelected, pendingAgent, preferences, setPreferences],
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
    [preferences, setPreferences],
  );

  const handleVoiceSelect = useCallback(
    (underlyingProvider: RealtimeVoiceUnderlyingProvider, voiceId: string) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
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
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
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
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      if (previous.stellaSubProvider === subProvider) return;
      void patchRealtimeVoice(
        { ...previous, stellaSubProvider: subProvider },
        "Failed to update voice family.",
      );
    },
    [patchRealtimeVoice, preferences],
  );

  const handleReadAloudProviderSelect = useCallback(
    (provider: ReadAloudVoiceProvider) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      if ((previous.readAloudProvider ?? "inworld") === provider) return;
      void patchRealtimeVoice(
        { ...previous, readAloudProvider: provider },
        "Failed to update read-aloud provider.",
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
    [onSelected, pendingAgent, preferences, setPreferences],
  );

  const handleReasoningEffortSelect = useCallback(
    async (effort: ReasoningEffort) => {
      if (!preferences || pendingAgent) return;
      const selectedEngine = preferences.agentRuntimeEngine;
      const writeKeys = activeAssistant ? assistantWriteKeys : [activeAgent];
      const previousReasoningEfforts = {
        ...(preferences.reasoningEfforts ?? {}),
      };
      const patch = buildEngineReasoningPatch(
        preferences,
        selectedEngine,
        effort,
        writeKeys,
      ) as Partial<LocalModelPreferences>;
      setPendingAgent(activeAgent);
      setPreferences({
        ...preferences,
        ...patch,
      });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        if (saved) setPreferences(saved);
        setError(null);
        onSelected?.();
      } catch (caught) {
        setPreferences((current) =>
          current
            ? {
                ...current,
                reasoningEfforts: previousReasoningEfforts,
                codexReasoningEffort: preferences.codexReasoningEffort,
                claudeCodeReasoningEffort:
                  preferences.claudeCodeReasoningEffort,
              }
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
      setPreferences,
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
    ? (overrides.orchestrator ?? overrides.general ?? "")
    : activeImage
      ? imagePreferences.provider
      : activeVoice
        ? voicePreferences.provider
        : (overrides[activeAgent] ?? "");
  // The Assistant tab maps to both orchestrator and general. Their plan
  // default can be different models (e.g. Kimi K2.6 vs K2.7 Code on non-Ultra
  // tiers), so naming a single model in the "Default" label would be
  // misleading — fall back to a plain "Stella Default" when they diverge.
  const assistantDefaultsDiverge =
    activeAssistant &&
    assistantWriteKeys
      .map((key) => resolvedDefaultModelMap[key] ?? defaultModelMap[key])
      .some((model, _index, models) => model !== models[0]);
  const defaultLabel = activeProviderSetting
    ? "Stella"
    : !ready
      ? "Default"
      : assistantDefaultsDiverge
        ? "Stella Default"
        : getDefaultModelOptionLabel(
            canonicalAgentKey,
            defaultModelMap,
            resolvedDefaultModelMap,
            modelNamesById,
          );
  const currentLabel = activeProviderSetting
    ? (IMAGE_PROVIDER_OPTIONS.find((entry) => entry.key === current)?.label ??
      VOICE_PROVIDER_OPTIONS.find((entry) => entry.key === current)?.label ??
      "Stella")
    : ready
      ? current
        ? getModelPickerDisplayLabel(current, modelNamesById)
        : defaultLabel
      : "Loading…";
  const selectedEngine = preferences?.agentRuntimeEngine ?? "default";
  const claudeCodeModelsWithCurrent = useMemo<EngineScopedModelOption[]>(() => {
    const models = claudeCodeModels ?? [];
    if (
      claudeCodeModels === null ||
      !selectedClaudeCodeModel ||
      models.some((model) => model.id === selectedClaudeCodeModel)
    ) {
      return models;
    }
    return [
      ...models,
      {
        id: selectedClaudeCodeModel,
        label: selectedClaudeCodeModel,
        description: "Unavailable",
        unavailable: true,
      },
    ];
  }, [claudeCodeModels, selectedClaudeCodeModel]);

  const currentReasoningEffort =
    selectedEngine === "codex_cli"
      ? (preferences?.codexReasoningEffort ?? "default")
      : selectedEngine === "claude_code_local"
        ? (preferences?.claudeCodeReasoningEffort ?? "default")
        : activeAssistant
          ? (preferences?.reasoningEfforts?.orchestrator ??
            preferences?.reasoningEfforts?.general ??
            "default")
          : (preferences?.reasoningEfforts?.[activeAgent] ?? "default");

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
          onClick={() =>
            selectedEngine === "claude_code_local"
              ? void loadClaudeCodeModels()
              : void refresh()
          }
          disabled={refreshing || claudeCodeModelsLoading}
          title={
            selectedEngine === "claude_code_local"
              ? "Refresh Claude Code models"
              : "Refresh model catalog"
          }
          aria-label={
            selectedEngine === "claude_code_local"
              ? "Refresh Claude Code models"
              : "Refresh model catalog"
          }
        >
          <RefreshCw
            size={13}
            strokeWidth={1.75}
            data-spinning={refreshing || claudeCodeModelsLoading || undefined}
          />
        </button>
      </div>

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
              readAloudProvider={voicePreferences.readAloudProvider}
              onSelectVoice={(underlyingProvider, voiceId) =>
                void handleVoiceSelect(underlyingProvider, voiceId)
              }
              onSelectStellaSubProvider={(sub) =>
                void handleStellaSubProviderSelect(sub)
              }
              onSelectInworldSpeed={(speed) =>
                void handleInworldSpeedSelect(speed)
              }
              onSelectReadAloudProvider={(provider) =>
                void handleReadAloudProviderSelect(provider)
              }
              disabled={!preferences || pendingAgent !== null}
            />
          </>
        ) : selectedEngine === "codex_cli" ? (
          <EngineScopedModelList
            engineLabel="ChatGPT"
            models={chatGptModels}
            value={selectedChatGptModel}
            onSelect={(modelId) => void handleEngineModelSelect(modelId)}
            loading={refreshing}
            disabled={!preferences || pendingAgent !== null}
          />
        ) : selectedEngine === "claude_code_local" ? (
          <EngineScopedModelList
            engineLabel="Claude Code"
            models={claudeCodeModelsWithCurrent}
            value={selectedClaudeCodeModel}
            onSelect={(modelId) => void handleEngineModelSelect(modelId)}
            loading={claudeCodeModelsLoading}
            disabled={!preferences || pendingAgent !== null}
          />
        ) : (
          <ProviderModelPanel
            value={current}
            defaultLabel={defaultLabel}
            currentLabel={currentLabel}
            groups={groups}
            disabled={!ready || pendingAgent !== null}
            restrictStellaPicks={restrictedStellaPicks}
            restrictedPlanLabel={restrictedPlanLabel}
            ariaLabel="Assistant model picker"
            onSelect={handleSelect}
          />
        )}

        {showChronicleStillOnStellaNotice ? (
          <p className="agent-model-picker-chronicle-notice">
            Screen memory still uses Stella.{" "}
            <button
              type="button"
              className="agent-model-picker-chronicle-link"
              onClick={() => {
                // Open the sidebar Models popover so Chronicle can be
                // configured without leaving chat.
                void router.navigate({ to: "/chat" });
                openEngineDisplayTab();
                onSelected?.();
              }}
            >
              Pick a small model for Chronicle
            </button>{" "}
            to switch.
          </p>
        ) : null}
      </div>

      {activeProviderSetting ? null : (
        <div className="agent-model-picker-footer">
          <div
            className="agent-model-picker-engine"
            role="radiogroup"
            aria-label="Engine"
          >
            {ENGINE_OPTIONS.map((option) => {
              const active = option.id === selectedEngine;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-active={active || undefined}
                  disabled={
                    !preferences ||
                    pendingAgent !== null ||
                    (option.id === "codex_cli" && credentials.loading)
                  }
                  onClick={() => void handleEngineChange(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
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
        </div>
      )}
    </div>
  );
}
