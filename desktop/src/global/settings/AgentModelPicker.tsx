import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Switch } from "@/ui/switch";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { useCodexModelCatalog } from "@/global/settings/hooks/use-codex-model-catalog";
import { useClaudeCodeModelCatalog } from "@/global/settings/hooks/use-claude-code-model-catalog";
import { BrandIcon } from "@/ui/brand-icon";
import { useEdgeFadeRef } from "@/shared/hooks/use-edge-fade";
import {
  compareProviderRailOrder,
  getLlmProviderEntry,
} from "@/global/settings/lib/llm-providers";
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
import { useLlmCredentials } from "@/global/settings/hooks/use-llm-credentials";
import { showToast } from "@/ui/toast";
import {
  buildEngineReasoningPatch,
  buildEngineRoutingPatch,
  buildEngineTransitionReasoningPatch,
  codexModelSupportsFast,
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_CODE_MODEL,
  fromOpenAiCodexModelId,
  intersectChatGptModels,
  listChatGptCatalogModels,
  OPENAI_CODEX_PROVIDER,
  resolveChatGptEngineModel,
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
  stellaConversationModelOverrides: Record<string, string>;
  stellaConversationReasoningEfforts: Record<string, ReasoningEffort>;
  agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
  codexModel: string;
  codexModelExplicit: boolean;
  codexReasoningEffort: ReasoningEffort;
  codexServiceTier: CodexServiceTier;
  claudeCodeModel: string;
  claudeCodeReasoningEffort: ReasoningEffort;
  useNativeAgentRuntimes: boolean;
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
type CodexServiceTier = "standard" | "fast";

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
const NATIVE_AGENT_RUNTIMES_PENDING_TARGET = "__native_agent_runtimes__";

/**
 * Which source a dual-source brand routes through. `app` is the subscription
 * runtime (ChatGPT via Codex CLI, Claude Code via the local CLI); `api` is
 * the BYOK API-key provider running on Stella's own runtime. The brand icon
 * in the rail always means "whose models" — this toggle picks the account
 * and engine behind them.
 */
type BrandSource = "app" | "api";

/** Map a saved model override to the brand it belongs to in the icon rail. */
function brandOfModelValue(value: string): string {
  if (!value || value.startsWith("stella/")) return "stella";
  if (value.startsWith("codex-cli/") || value.startsWith("openai-codex/")) {
    return "openai";
  }
  if (value.startsWith("claude-code/")) return "anthropic";
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : "stella";
}

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

export const IMAGE_PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    key: "stella",
    label: "Stella",
    description:
      "Default. Uses Stella's managed image service; local references require per-generation upload consent.",
  },
  {
    key: "openai",
    label: "OpenAI",
    description:
      "Uses your key. References go directly from this device to OpenAI; an ambiguous lost response is reported as unknown and is never blindly retried.",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    description:
      "Uses your key. References go directly from this device to OpenRouter; an ambiguous lost response is reported as unknown and is never blindly retried.",
  },
  {
    key: "fal",
    label: "fal",
    description:
      "Uses your key. References go directly from this device to fal; an ambiguous lost response is reported as unknown and is never blindly retried.",
  },
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
  /** Whether the surrounding surface is currently visible. */
  active?: boolean;
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
  active = true,
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
    error: catalogError,
  } = useModelCatalog();

  const [preferences, setPreferencesRaw] =
    useState<LocalModelPreferences | null>(() => cachedLocalPreferences);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const credentials = useLlmCredentials();
  const cancelOAuth = credentials.cancelOAuth;
  const validateOAuth = credentials.validateOAuth;
  const codexCatalog = useCodexModelCatalog(active);
  const [chatGptConnection, setChatGptConnection] = useState<
    "checking" | "connected" | "disconnected" | "needs-reauth"
  >("checking");
  // Soft status shown when a genuinely-gone saved ChatGPT model was rerouted
  // to an available one, so the switch is never silent.
  const [chatGptRoutedNotice, setChatGptRoutedNotice] = useState<string | null>(
    null,
  );
  // Scroll-edge fade for the brand rail: `data-at-start` / `data-at-end`
  // drive the tapered mask so the cut-off icon signals more to scroll.
  const brandRailRef = useEdgeFadeRef<HTMLDivElement>();
  // Icon-rail navigation state. `null` means "derive from preferences":
  // the committed engine (ChatGPT/Claude Code) or the active override's
  // provider decides which brand panel shows when the picker opens.
  const [activeBrandRaw, setActiveBrandRaw] = useState<string | null>(null);
  const [openaiSourceRaw, setOpenaiSourceRaw] = useState<BrandSource | null>(
    null,
  );
  const [anthropicSourceRaw, setAnthropicSourceRaw] =
    useState<BrandSource | null>(null);

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
    () =>
      codexCatalog.models
        ? intersectChatGptModels(allModels, codexCatalog.models)
        : [],
    [allModels, codexCatalog.models],
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
  // Every openai-codex id known to the static registry (independent of the
  // live model/list) so we can tell a genuinely-removed model from a
  // transient live-list gap.
  const chatGptRegistryIds = useMemo(
    () => listChatGptCatalogModels(allModels).map((model) => model.modelId),
    [allModels],
  );
  const savedChatGptOverride = preferences
    ? fromOpenAiCodexModelId(
        preferences.modelOverrides.orchestrator ??
          preferences.modelOverrides.general ??
          "",
      )
    : null;
  const selectedChatGptModel =
    savedChatGptOverride ?? preferences?.codexModel ?? DEFAULT_CHATGPT_MODEL;
  const selectedChatGptLiveModel =
    codexCatalog.models?.find((model) => model.id === selectedChatGptModel) ??
    null;
  const selectedChatGptSupportsFast = codexModelSupportsFast(
    selectedChatGptLiveModel,
  );
  const chatGptCatalogSettled =
    !codexCatalog.loading && codexCatalog.models !== null;
  const selectedChatGptModelUnavailable =
    chatGptCatalogSettled &&
    Boolean(selectedChatGptModel) &&
    !chatGptModels.some((model) => model.id === selectedChatGptModel);
  const chatGptModelsWithCurrent = useMemo<EngineScopedModelOption[]>(() => {
    if (
      !chatGptCatalogSettled ||
      !selectedChatGptModel ||
      chatGptModels.some((model) => model.id === selectedChatGptModel)
    ) {
      return chatGptModels;
    }
    return [
      ...chatGptModels,
      {
        id: selectedChatGptModel,
        label: selectedChatGptModel,
        description: "Unavailable — choose another model",
        unavailable: true,
      },
    ];
  }, [chatGptCatalogSettled, chatGptModels, selectedChatGptModel]);
  // Even without a ChatGPT connection the static registry knows which
  // OpenAI models the ChatGPT engine can route — show those instead of an
  // empty wall. Picking one starts the OAuth flow.
  const chatGptRegistryOptions = useMemo<EngineScopedModelOption[]>(
    () =>
      listChatGptCatalogModels(allModels).map((model) => ({
        id: model.modelId,
        label: model.name || model.modelId,
        description: model.modelId,
      })),
    [allModels],
  );
  const chatGptDisplayModels =
    chatGptModels.length > 0
      ? chatGptModelsWithCurrent
      : chatGptRegistryOptions;
  const selectedClaudeCodeModel =
    preferences?.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL;
  const committedEngine = preferences?.agentRuntimeEngine ?? "default";
  const oauthPendingRef = useRef(false);
  const migrationAttemptedRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (oauthPendingRef.current) {
        void cancelOAuth(OPENAI_CODEX_PROVIDER);
      }
    },
    [cancelOAuth],
  );

  // (The ChatGPT connection check is triggered below, once the active
  // brand/source panel is derived.)

  useEffect(() => {
    if (
      !preferences ||
      pendingAgent !== null ||
      preferences.agentRuntimeEngine !== "codex_cli" ||
      chatGptConnection !== "connected" ||
      !chatGptModels.some((model) => model.id === selectedChatGptModel)
    ) {
      return;
    }
    const route = `${OPENAI_CODEX_PROVIDER}/${selectedChatGptModel}`;
    if (
      preferences.modelOverrides.orchestrator === route &&
      preferences.modelOverrides.general === route
    ) {
      return;
    }
    const migrationKey = `${selectedChatGptModel}:${preferences.modelOverrides.orchestrator ?? ""}:${preferences.modelOverrides.general ?? ""}`;
    if (migrationAttemptedRef.current === migrationKey) return;
    migrationAttemptedRef.current = migrationKey;
    setPendingAgent(ENGINE_PENDING_TARGET);
    const patch = {
      ...buildEngineRoutingPatch(
        preferences,
        "codex_cli",
        selectedChatGptModel,
      ),
      ...buildEngineTransitionReasoningPatch(preferences, "codex_cli"),
    } as Partial<LocalModelPreferences>;
    void (async () => {
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        if (saved) setPreferences(saved);
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "ChatGPT routing migration failed.",
        );
      } finally {
        setPendingAgent(null);
      }
    })();
  }, [
    chatGptConnection,
    chatGptModels,
    pendingAgent,
    preferences,
    selectedChatGptModel,
    setPreferences,
  ]);

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
   * Brand icon rail: one entry per catalog provider that has models, with
   * `openai-codex` folded into OpenAI (it's the same brand through the
   * ChatGPT subscription). Stella, OpenAI, and Anthropic always show even
   * with an empty catalog so their engine/connect flows stay reachable.
   */
  const railBrands = useMemo(() => {
    const labels = new Map<string, string>();
    for (const group of groups) {
      if (group.models.length === 0) continue;
      const key =
        group.provider === OPENAI_CODEX_PROVIDER ? "openai" : group.provider;
      if (!labels.has(key)) labels.set(key, group.providerName);
    }
    for (const key of ["stella", "openai", "anthropic"]) {
      if (!labels.has(key)) {
        labels.set(key, getLlmProviderEntry(key)?.label ?? key);
      }
    }
    return Array.from(labels, ([key, label]) => ({ key, label })).sort((a, b) =>
      compareProviderRailOrder(a.key, b.key, a.label, b.label),
    );
  }, [groups]);

  /** Saved model override for the active tab (assistant reads orchestrator
   * with general as fallback, same as `current` below). */
  const activeModelValue = activeAssistant
    ? (overrides.orchestrator ?? overrides.general ?? "")
    : (overrides[activeAgent] ?? "");

  const derivedBrand =
    committedEngine === "codex_cli"
      ? "openai"
      : committedEngine === "claude_code_local"
        ? "anthropic"
        : brandOfModelValue(activeModelValue);
  const activeBrand = activeBrandRaw ?? derivedBrand;
  // Subscription source is the default; the API-key source is derived only
  // from an actual API-provider override so re-opening the picker lands on
  // whatever the user last committed.
  const openaiSource =
    openaiSourceRaw ??
    (committedEngine !== "codex_cli" && activeModelValue.startsWith("openai/")
      ? "api"
      : "app");
  const anthropicSource =
    anthropicSourceRaw ??
    (committedEngine !== "claude_code_local" &&
    activeModelValue.startsWith("anthropic/")
      ? "api"
      : "app");
  const showChatGptPanel =
    !activeProviderSetting &&
    activeBrand === "openai" &&
    openaiSource === "app";
  const showClaudeCodePanel =
    !activeProviderSetting &&
    activeBrand === "anthropic" &&
    anthropicSource === "app";
  const claudeCodeCatalog = useClaudeCodeModelCatalog(
    active && (showClaudeCodePanel || committedEngine === "claude_code_local"),
  );
  const claudeCodeModels = useMemo<EngineScopedModelOption[] | null>(
    () =>
      claudeCodeCatalog.models?.map((model) => ({
        id: model.id,
        label: model.displayName || model.id,
        description: model.description,
      })) ?? null,
    [claudeCodeCatalog.models],
  );
  const claudeCodeModelsLoading = claudeCodeCatalog.loading;
  const visiblePickerError =
    error ??
    claudeCodeCatalog.error ??
    catalogError ??
    (showChatGptPanel && codexCatalog.error
      ? `ChatGPT models could not be verified: ${codexCatalog.error}`
      : null);
  const visiblePickerErrorTitle = error
    ? "Couldn't update model settings"
    : "Couldn't refresh models";
  const lastToastedErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!visiblePickerError) {
      lastToastedErrorRef.current = null;
      return;
    }
    if (!active || lastToastedErrorRef.current === visiblePickerError) return;
    lastToastedErrorRef.current = visiblePickerError;
    showToast({
      title: visiblePickerErrorTitle,
      description: visiblePickerError,
      variant: "error",
    });
  }, [active, visiblePickerError, visiblePickerErrorTitle]);

  // Check the ChatGPT OAuth session whenever its panel is on screen (so the
  // connect notice is accurate before any commit), and always while the
  // committed engine is ChatGPT (the auto-migration effect depends on it).
  useEffect(() => {
    if (!active || (!showChatGptPanel && committedEngine !== "codex_cli")) {
      return;
    }
    let cancelled = false;
    void validateOAuth(OPENAI_CODEX_PROVIDER).then((result) => {
      if (!cancelled) {
        setChatGptConnection(
          result.connected
            ? "connected"
            : result.needsReauth
              ? "needs-reauth"
              : "disconnected",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, committedEngine, showChatGptPanel, validateOAuth]);

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
      // Picking any model outside the engine panels routes back through
      // Stella's own runtime, so a committed ChatGPT/Claude Code engine is
      // reverted in the same write (selection implies engine).
      const engineRevertPatch =
        preferences.agentRuntimeEngine !== "default"
          ? ({
              ...buildEngineRoutingPatch(preferences, "default"),
              ...buildEngineTransitionReasoningPatch(preferences, "default"),
            } as Partial<LocalModelPreferences>)
          : null;
      if (engineRevertPatch) migrationAttemptedRef.current = null;
      const basePreferences = engineRevertPatch
        ? { ...preferences, ...engineRevertPatch }
        : preferences;
      const previousOverrides = { ...basePreferences.modelOverrides };
      const previousPropagated = [
        ...(basePreferences.assistantPropagatedAgents ?? []),
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
      // After the (possible) engine revert the effective engine is always
      // "default", so the Stella conversation mirror syncs unconditionally.
      const nextStellaConversationModelOverrides = {
        ...(basePreferences.stellaConversationModelOverrides ?? {}),
      };
      for (const key of ASSISTANT_AGENT_KEYS) {
        if (nextOverrides[key]) {
          nextStellaConversationModelOverrides[key] = nextOverrides[key];
        } else {
          delete nextStellaConversationModelOverrides[key];
        }
      }
      setPreferences({
        ...basePreferences,
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: nextPropagated,
        stellaConversationModelOverrides: nextStellaConversationModelOverrides,
      });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            ...(engineRevertPatch ?? {}),
            modelOverrides: nextOverrides,
            assistantPropagatedAgents: nextPropagated,
            stellaConversationModelOverrides:
              nextStellaConversationModelOverrides,
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
        // Full restore: the optimistic write may have included an engine
        // revert, so partial rollbacks would leave mixed state.
        setPreferences(preferences);
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
    async (
      engine: ModelPickerEngine,
      modelId?: string,
      options?: { explicit?: boolean },
    ): Promise<boolean> => {
      if (!preferences || pendingAgent) return false;
      migrationAttemptedRef.current = null;
      const previous = preferences;
      setPendingAgent(ENGINE_PENDING_TARGET);
      setError(null);
      setChatGptRoutedNotice(null);
      // ChatGPT auto-matches to an available OpenAI model; the model id passed
      // into the routing patch is resolved below so selection never dead-ends
      // on a "choose a model" gate. Auth is the only real interruption.
      let effectiveModelId = modelId;
      try {
        if (engine === "codex_cli") {
          if (codexCatalog.loading) {
            throw new Error("Wait for ChatGPT models to finish verifying.");
          }
          const selectedModel = modelId?.trim() || preferences.codexModel;
          setChatGptConnection("checking");
          let validation = await credentials.validateOAuth(
            OPENAI_CODEX_PROVIDER,
          );
          if (!validation.connected) {
            oauthPendingRef.current = true;
            await credentials.loginOAuth(OPENAI_CODEX_PROVIDER, {
              announceConnection: false,
            });
            oauthPendingRef.current = false;
            validation = await credentials.validateOAuth(OPENAI_CODEX_PROVIDER);
          }
          if (!validation.connected) {
            setChatGptConnection(
              validation.needsReauth ? "needs-reauth" : "disconnected",
            );
            throw new Error("ChatGPT needs to be connected before selection.");
          }
          setChatGptConnection("connected");
          const resolution = resolveChatGptEngineModel(
            selectedModel,
            chatGptModels.map((model) => model.id),
            chatGptRegistryIds,
            DEFAULT_CHATGPT_MODEL,
          );
          if (resolution.kind === "unavailable") {
            throw new Error(
              codexCatalog.error ??
                "No ChatGPT models are currently available.",
            );
          }
          // transient-gap keeps the saved (registry-routable) model rather than
          // silently switching on a flaky live-list miss; rerouted surfaces a
          // notice so a genuine switch is never silent.
          effectiveModelId = resolution.modelId;
          if (resolution.kind === "rerouted") {
            setChatGptRoutedNotice(
              `Routed to ${resolution.modelId} (saved model unavailable).`,
            );
          }
        }

        const patch = {
          ...buildEngineRoutingPatch(preferences, engine, effectiveModelId),
          ...buildEngineTransitionReasoningPatch(preferences, engine),
          ...(engine === "codex_cli" &&
          effectiveModelId &&
          codexCatalog.models?.some(
            (model) =>
              model.id === effectiveModelId && !codexModelSupportsFast(model),
          )
            ? { codexServiceTier: "standard" as const }
            : {}),
          // Record provenance only for an explicit ChatGPT model pick so
          // Stella Light honors it; engine switches / auto-matches leave the
          // marker untouched.
          ...(engine === "codex_cli" && options?.explicit
            ? { codexModelExplicit: true }
            : {}),
        } as Partial<LocalModelPreferences>;
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
        oauthPendingRef.current = false;
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
    [
      chatGptModels,
      chatGptRegistryIds,
      codexCatalog.error,
      codexCatalog.loading,
      codexCatalog.models,
      credentials,
      pendingAgent,
      preferences,
      setPreferences,
    ],
  );

  const handleEngineModelSelect = useCallback(
    async (engine: ModelPickerEngine, modelId: string) => {
      if (!preferences) return;
      // Selecting a row from an engine panel is an explicit user pick and
      // commits that engine (selection implies engine).
      const saved = await commitEngineSelection(engine, modelId, {
        explicit: true,
      });
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
      migrationAttemptedRef.current = null;
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

  const handleCodexServiceTierSelect = useCallback(
    async (serviceTier: CodexServiceTier) => {
      if (
        !preferences ||
        pendingAgent ||
        preferences.agentRuntimeEngine !== "codex_cli" ||
        (serviceTier === "fast" && !selectedChatGptSupportsFast)
      ) {
        return;
      }
      const previousServiceTier = preferences.codexServiceTier;
      const patch: Partial<LocalModelPreferences> = {
        codexServiceTier: serviceTier,
      };
      setPendingAgent(ENGINE_PENDING_TARGET);
      setPreferences({ ...preferences, ...patch });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        if (saved) setPreferences(saved);
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
        setError(null);
        onSelected?.();
      } catch (caught) {
        setPreferences((current) =>
          current
            ? { ...current, codexServiceTier: previousServiceTier }
            : current,
        );
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to update ChatGPT speed.",
        );
      } finally {
        setPendingAgent(null);
      }
    },
    [
      onSelected,
      pendingAgent,
      preferences,
      selectedChatGptSupportsFast,
      setPreferences,
    ],
  );

  const handleNativeAgentRuntimesChange = useCallback(
    async (useNativeAgentRuntimes: boolean) => {
      if (!preferences || pendingAgent) return;
      const previous = preferences.useNativeAgentRuntimes === true;
      setPendingAgent(NATIVE_AGENT_RUNTIMES_PENDING_TARGET);
      setError(null);
      setPreferences({
        ...preferences,
        useNativeAgentRuntimes,
      });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            useNativeAgentRuntimes,
          });
        if (saved) setPreferences(saved);
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
      } catch (caught) {
        setPreferences((current) =>
          current ? { ...current, useNativeAgentRuntimes: previous } : current,
        );
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to update native agent runtime setting.",
        );
      } finally {
        setPendingAgent(null);
      }
    },
    [pendingAgent, preferences, setPreferences],
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
  /** Footer summary of what's committed right now (engine-aware). */
  const footerModelLabel =
    committedEngine === "codex_cli"
      ? `ChatGPT · ${selectedChatGptModel}`
      : committedEngine === "claude_code_local"
        ? `Claude Code · ${
            CLAUDE_CODE_ALIAS_LABELS[selectedClaudeCodeModel] ??
            selectedClaudeCodeModel
          }`
        : currentLabel;
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
    committedEngine === "codex_cli"
      ? (preferences?.codexReasoningEffort ?? "default")
      : committedEngine === "claude_code_local"
        ? (preferences?.claudeCodeReasoningEffort ?? "default")
        : activeAssistant
          ? (preferences?.reasoningEfforts?.orchestrator ??
            preferences?.reasoningEfforts?.general ??
            "default")
          : (preferences?.reasoningEfforts?.[activeAgent] ?? "default");
  const currentCodexServiceTier = preferences?.codexServiceTier ?? "standard";

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
      onClick={() => {
        setActiveAgent(key);
        // Each tab re-derives its brand/source from saved preferences.
        setActiveBrandRaw(null);
        setOpenaiSourceRaw(null);
        setAnthropicSourceRaw(null);
      }}
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
          onClick={() => {
            if (showClaudeCodePanel) {
              void claudeCodeCatalog.refresh();
            } else if (showChatGptPanel) {
              migrationAttemptedRef.current = null;
              void Promise.all([codexCatalog.refresh(), refresh()]);
            } else {
              void refresh();
            }
          }}
          disabled={
            pendingAgent !== null ||
            refreshing ||
            claudeCodeModelsLoading ||
            codexCatalog.loading
          }
          title={
            showClaudeCodePanel
              ? "Refresh Claude Code models"
              : "Refresh model catalog"
          }
          aria-label={
            showClaudeCodePanel
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
        {pendingAgent === ENGINE_PENDING_TARGET && oauthPendingRef.current ? (
          <p className="agent-model-picker-connection" role="status">
            Waiting for ChatGPT…{" "}
            <button
              type="button"
              onClick={() =>
                void credentials.cancelOAuth(OPENAI_CODEX_PROVIDER)
              }
            >
              Cancel
            </button>
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
        ) : (
          <>
            <div
              ref={brandRailRef}
              className="agent-model-picker-brands"
              role="tablist"
              aria-label="Provider"
            >
              {railBrands.map((brand) => (
                <button
                  key={brand.key}
                  type="button"
                  role="tab"
                  aria-selected={brand.key === activeBrand}
                  aria-label={brand.label}
                  title={brand.label}
                  className="agent-model-picker-brand"
                  data-active={brand.key === activeBrand || undefined}
                  onClick={() => setActiveBrandRaw(brand.key)}
                  disabled={pendingAgent !== null}
                >
                  <BrandIcon brand={brand.key} size={17} />
                </button>
              ))}
            </div>
            {activeBrand === "openai" || activeBrand === "anthropic" ? (
              <div
                className="agent-model-picker-source"
                role="tablist"
                aria-label="Connection"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={
                    (activeBrand === "openai"
                      ? openaiSource
                      : anthropicSource) === "app"
                  }
                  data-active={
                    (activeBrand === "openai"
                      ? openaiSource
                      : anthropicSource) === "app" || undefined
                  }
                  onClick={() =>
                    activeBrand === "openai"
                      ? setOpenaiSourceRaw("app")
                      : setAnthropicSourceRaw("app")
                  }
                  disabled={pendingAgent !== null}
                >
                  {activeBrand === "openai" ? "ChatGPT" : "Claude Code"}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={
                    (activeBrand === "openai"
                      ? openaiSource
                      : anthropicSource) === "api"
                  }
                  data-active={
                    (activeBrand === "openai"
                      ? openaiSource
                      : anthropicSource) === "api" || undefined
                  }
                  onClick={() =>
                    activeBrand === "openai"
                      ? setOpenaiSourceRaw("api")
                      : setAnthropicSourceRaw("api")
                  }
                  disabled={pendingAgent !== null}
                >
                  API key
                </button>
              </div>
            ) : null}
            {showChatGptPanel ? (
              <>
                {chatGptConnection === "disconnected" ||
                chatGptConnection === "needs-reauth" ? (
                  <p className="agent-model-picker-connection">
                    {chatGptConnection === "needs-reauth"
                      ? "ChatGPT needs to be reconnected."
                      : "ChatGPT is disconnected."}{" "}
                    <button
                      type="button"
                      disabled={pendingAgent !== null || codexCatalog.loading}
                      onClick={() =>
                        void commitEngineSelection(
                          "codex_cli",
                          selectedChatGptModel,
                        )
                      }
                    >
                      Connect
                    </button>
                  </p>
                ) : null}
                {codexCatalog.loading ? (
                  <p className="agent-model-picker-connection" role="status">
                    Verifying ChatGPT models…
                  </p>
                ) : chatGptDisplayModels.length === 0 ? (
                  <p className="agent-model-picker-connection" role="status">
                    No models are currently available to both ChatGPT and Codex.
                  </p>
                ) : chatGptConnection === "connected" &&
                  selectedChatGptModelUnavailable ? (
                  <p className="agent-model-picker-connection" role="status">
                    The saved model is unavailable. Choose another model.
                  </p>
                ) : chatGptRoutedNotice ? (
                  <p className="agent-model-picker-connection" role="status">
                    {chatGptRoutedNotice}
                  </p>
                ) : null}
                <EngineScopedModelList
                  engineLabel="ChatGPT"
                  hideHead
                  models={chatGptDisplayModels}
                  value={
                    committedEngine === "codex_cli" ? selectedChatGptModel : ""
                  }
                  onSelect={(modelId) =>
                    void handleEngineModelSelect("codex_cli", modelId)
                  }
                  emptyMessage={null}
                  disabled={
                    !preferences ||
                    pendingAgent !== null ||
                    codexCatalog.loading
                  }
                />
              </>
            ) : showClaudeCodePanel ? (
              <EngineScopedModelList
                engineLabel="Claude Code"
                hideHead
                models={claudeCodeModelsWithCurrent}
                value={
                  committedEngine === "claude_code_local"
                    ? selectedClaudeCodeModel
                    : ""
                }
                onSelect={(modelId) =>
                  void handleEngineModelSelect("claude_code_local", modelId)
                }
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
                visibleProviders={[activeBrand]}
                hideSelectedTitle
                hideProviderLabel
                hideSearch={activeBrand === "stella"}
              />
            )}
          </>
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
          <div className="agent-model-picker-footer-main">
            <span
              className="agent-model-picker-engine-note"
              title={footerModelLabel}
            >
              <BrandIcon brand={derivedBrand} size={13} />
              <span className="agent-model-picker-engine-note-text">
                {footerModelLabel}
              </span>
            </span>
            <div className="agent-model-picker-controls">
              {committedEngine === "codex_cli" &&
              selectedChatGptSupportsFast ? (
                <Switch
                  className="agent-model-picker-fast-toggle"
                  label="Fast"
                  checked={currentCodexServiceTier === "fast"}
                  onCheckedChange={(checked) => {
                    void handleCodexServiceTierSelect(
                      checked ? "fast" : "standard",
                    );
                  }}
                  title="Fast uses more ChatGPT credits."
                  aria-label="Fast ChatGPT responses"
                  disabled={
                    pendingAgent !== null ||
                    chatGptConnection !== "connected" ||
                    codexCatalog.loading
                  }
                />
              ) : null}
              <div className="agent-model-picker-reasoning">
                <span>Reasoning</span>
                <Select
                  value={currentReasoningEffort}
                  onValueChange={(value) => {
                    if (isReasoningEffort(value)) {
                      void handleReasoningEffortSelect(value);
                    }
                  }}
                  disabled={
                    pendingAgent !== null ||
                    (committedEngine === "codex_cli" &&
                      (chatGptConnection !== "connected" ||
                        codexCatalog.loading))
                  }
                  aria-label="Reasoning effort"
                  options={REASONING_EFFORT_OPTIONS.filter(
                    (option) =>
                      committedEngine !== "claude_code_local" ||
                      option.id !== "minimal",
                  ).map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                />
              </div>
            </div>
          </div>
          <label className="agent-model-picker-native-runtime-option">
            <input
              type="checkbox"
              checked={preferences?.useNativeAgentRuntimes === true}
              disabled={!preferences || pendingAgent !== null}
              onChange={(event) =>
                void handleNativeAgentRuntimesChange(event.target.checked)
              }
            />
            <span className="agent-model-picker-native-runtime-copy">
              <span>Use native Codex and Claude Code</span>
              <span className="agent-model-picker-native-runtime-helper">
                Checked runs them directly using their native configuration,
                skills, and MCPs. Unchecked uses Stella&apos;s harness.
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
