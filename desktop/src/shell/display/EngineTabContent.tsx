/**
 * Engine tab — the workspace panel's home for everything model & runtime.
 *
 * Replaces the old Settings → Models page. Single surface covers:
 *
 *   - Picking the agent runtime engine (Stella / Codex / Claude Code) and
 *     Codex reasoning when Codex is selected.
 *   - Assigning a Stella / Grok / Codex / Claude Code model across the agent set
 *     with Chronicle left on its cheap default.
 *   - Choosing the image and realtime-voice provider (and per-voice
 *     selection for voice).
 *   - Disconnecting / signing out of providers the user has linked on
 *     this device.
 *
 * The layout is flat by design: a single column with typographic
 * section headers, no nested cards, no decorative chrome. The panel
 * fits inside the narrow display sidebar but happily uses the extra
 * room when the user expands the panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, RefreshCw, RotateCcw } from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import {
  ProviderOnlyPicker,
  type ProviderOption,
} from "@/global/settings/ProviderOnlyPicker";
import { VoiceProviderPicker } from "@/global/settings/VoiceProviderPicker";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { useCodexModelCatalog } from "@/global/settings/hooks/use-codex-model-catalog";
import { EnginePickerPill } from "@/global/settings/EnginePickerPill";
import { getStellaDisplayName } from "@/global/settings/lib/model-catalog";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getConfigurableAgents,
  getDefaultModelOptionLabel,
  getLocalModelDefaults,
  normalizeModelOverrides,
} from "@/global/settings/lib/model-defaults";
import {
  getPlanLabel,
  isRestrictedModelOverrideAudience,
} from "@/global/billing/audience";
import type { RealtimeVoicePreferences } from "../../../../runtime/contracts/local-preferences";
import { DEFAULT_CODEX_MODEL } from "../../../../runtime/contracts/agent-engine";
import { EngineRuntimeModelPanel } from "./EngineRuntimeModelPanel";
import { useLlmCredentials } from "@/global/settings/hooks/use-llm-credentials";
import {
  buildEngineReasoningPatch,
  buildEngineRoutingPatch,
  buildEngineTransitionReasoningPatch,
  intersectChatGptModels,
  OPENAI_CODEX_PROVIDER,
} from "@/global/settings/lib/engine-model-routing";
import "./engine-tab.css";

/* ── types ────────────────────────────────────────────────────── */

type AgentRuntimeEngine = "default" | "claude_code_local" | "codex_cli";

type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

type CodexReasoningPreference =
  | Exclude<CodexReasoningEffort, "none">
  | "default";

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
  agentRuntimeEngine: AgentRuntimeEngine;
  codexModel: string;
  codexReasoningEffort: CodexReasoningPreference;
  claudeCodeModel: string;
  claudeCodeReasoningEffort: ReasoningEffort;
  maxAgentConcurrency: number;
  imageGeneration: ImageGenerationPreferences;
  realtimeVoice: RealtimeVoicePreferences;
};

type ClaudeCodeModelOption = {
  id: string;
  displayName: string;
  description?: string;
  source: "alias" | "anthropic";
};

type MediaTab = "agents" | "image" | "voice";

type SavingKind =
  | "engine"
  | "codex-model"
  | "claude-code-model"
  | "overrides"
  | "image"
  | "voice"
  | null;

type StatusKind = "notice" | "error";

interface Status {
  kind: StatusKind;
  text: string;
}

/* ── constants ────────────────────────────────────────────────── */

const ENGINE_OPTIONS: ReadonlyArray<{
  id: AgentRuntimeEngine;
  label: string;
}> = [
  { id: "default", label: "Stella" },
  { id: "codex_cli", label: "ChatGPT" },
  { id: "claude_code_local", label: "Claude Code" },
];

const MEDIA_TABS: ReadonlyArray<{ id: MediaTab; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "image", label: "Image" },
  { id: "voice", label: "Voice" },
];

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

const DEFAULT_IMAGE_GENERATION: ImageGenerationPreferences = {
  provider: "stella",
};
const DEFAULT_REALTIME_VOICE: RealtimeVoicePreferences = {
  provider: "stella",
};

const DEFAULT_CLAUDE_CODE_MODEL = "default";
const DEFAULT_CODEX_REASONING: CodexReasoningPreference = "default";
const DEFAULT_CLAUDE_CODE_REASONING: ReasoningEffort = "default";
const PREFS_EVENT = "stella:local-model-preferences-changed";
const NOTICE_TTL_MS = 2400;

const CONVERSATION_AGENT_KEYS: ReadonlySet<string> = new Set([
  "orchestrator",
  "general",
]);

const STELLA_PROVIDER_PREFIX = "stella/";
const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
const GENERAL_AGENT_KEY = "general";
const CHRONICLE_AGENT_KEY = "chronicle";

type RuntimeModelEngine = Extract<
  AgentRuntimeEngine,
  "codex_cli" | "claude_code_local"
>;

const usesRuntimeModelPicker = (
  engine: AgentRuntimeEngine,
): engine is RuntimeModelEngine =>
  engine === "codex_cli" || engine === "claude_code_local";

const isStellaModelId = (modelId: string): boolean =>
  modelId === "" || modelId.startsWith(STELLA_PROVIDER_PREFIX);

const fromRuntimeOverrideId = (modelId: string): string => {
  if (modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX)) {
    return modelId.slice(CLAUDE_CODE_MODEL_PREFIX.length);
  }
  return modelId;
};

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

/**
 * Last-known local preferences cached at module scope so reopening the
 * panel after a remount doesn't flash a loading state.
 */
let cachedPreferences: LocalModelPreferences | null = null;

/* ── component ────────────────────────────────────────────────── */

export function EngineTabContent() {
  const { allModels: engineCatalogModels } = useModelCatalog();
  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    () => cachedPreferences,
  );
  const [claudeCodeModels, setClaudeCodeModels] = useState<
    ClaudeCodeModelOption[]
  >([]);
  const [claudeCodeModelsLoading, setClaudeCodeModelsLoading] = useState(false);
  const [loading, setLoading] = useState(() => cachedPreferences === null);
  const [saving, setSaving] = useState<SavingKind>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [mediaTab, setMediaTab] = useState<MediaTab>("agents");
  const credentials = useLlmCredentials();
  const codexCatalog = useCodexModelCatalog();
  const [chatGptConnection, setChatGptConnection] = useState<
    "checking" | "connected" | "disconnected" | "needs-reauth"
  >("checking");
  const [draftEngine, setDraftEngine] = useState<AgentRuntimeEngine | null>(
    null,
  );
  const oauthPendingRef = useRef(false);
  const migrationAttemptedRef = useRef<string | null>(null);

  const selfDispatchRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const claudeCodeModelsLoadedRef = useRef(false);

  const selectedEngine =
    draftEngine ?? preferences?.agentRuntimeEngine ?? "default";
  const inputsDisabled = loading || saving !== null;

  /* ── status helpers ─────────────────────────────────────────── */

  const showNotice = useCallback((text: string) => {
    setStatus({ kind: "notice", text });
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setStatus((current) =>
        current?.kind === "notice" && current.text === text ? null : current,
      );
    }, NOTICE_TTL_MS);
  }, []);

  const showError = useCallback((text: string) => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setStatus({ kind: "error", text });
  }, []);

  const clearStatus = useCallback(() => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setStatus(null);
  }, []);

  /* ── preferences IO ─────────────────────────────────────────── */

  const applySavedPrefs = useCallback(
    (saved: LocalModelPreferences | null | undefined) => {
      if (!saved) return;
      const next: LocalModelPreferences = {
        ...saved,
        codexModel: saved.codexModel || DEFAULT_CODEX_MODEL,
        codexReasoningEffort:
          saved.codexReasoningEffort || DEFAULT_CODEX_REASONING,
        claudeCodeModel: saved.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL,
        claudeCodeReasoningEffort:
          saved.claudeCodeReasoningEffort || DEFAULT_CLAUDE_CODE_REASONING,
      };
      cachedPreferences = next;
      setPreferences(next);
    },
    [],
  );

  const notifyPrefsChanged = useCallback(() => {
    selfDispatchRef.current = true;
    window.dispatchEvent(new CustomEvent(PREFS_EVENT));
  }, []);

  const writePreferences = useCallback(
    async (
      patch: Partial<LocalModelPreferences>,
      kind: SavingKind,
    ): Promise<LocalModelPreferences | null> => {
      if (!preferences) return null;
      const previous = preferences;
      const optimistic: LocalModelPreferences = { ...previous, ...patch };
      const markSaving = kind !== null;
      cachedPreferences = optimistic;
      setPreferences(optimistic);
      if (markSaving) {
        setSaving(kind);
        clearStatus();
      }
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        const next = (saved as LocalModelPreferences | undefined) ?? optimistic;
        cachedPreferences = next;
        if (markSaving) {
          setPreferences(next);
        }
        notifyPrefsChanged();
        return next;
      } catch (caught) {
        cachedPreferences = previous;
        setPreferences(previous);
        showError(errorText(caught, "Could not save model setting."));
        return null;
      } finally {
        if (markSaving) {
          setSaving(null);
        }
      }
    },
    [clearStatus, notifyPrefsChanged, preferences, showError],
  );

  const loadClaudeCodeModels = useCallback(async () => {
    setClaudeCodeModelsLoading(true);
    try {
      const result = await window.electronAPI?.system?.listClaudeCodeModels?.();
      setClaudeCodeModels(result?.models ?? []);
      claudeCodeModelsLoadedRef.current = true;
    } catch (caught) {
      showError(errorText(caught, "Claude Code models did not load."));
    } finally {
      setClaudeCodeModelsLoading(false);
    }
  }, [showError]);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent && cachedPreferences === null) {
        setLoading(true);
      }
      try {
        const prefs =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        applySavedPrefs(prefs as LocalModelPreferences | undefined);
        if (
          prefs?.agentRuntimeEngine === "claude_code_local" &&
          !claudeCodeModelsLoadedRef.current
        ) {
          void loadClaudeCodeModels();
        }
      } catch (caught) {
        showError(errorText(caught, "Engine settings did not load."));
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [applySavedPrefs, loadClaudeCodeModels, showError],
  );

  useEffect(() => {
    if (
      selectedEngine === "claude_code_local" &&
      !claudeCodeModelsLoadedRef.current
    ) {
      void loadClaudeCodeModels();
    }
  }, [loadClaudeCodeModels, selectedEngine]);

  useEffect(() => {
    if (selectedEngine !== "codex_cli") return;
    let cancelled = false;
    void credentials.validateOAuth(OPENAI_CODEX_PROVIDER).then((result) => {
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
  }, [credentials.validateOAuth, selectedEngine]);

  useEffect(() => {
    if (
      !preferences ||
      preferences.agentRuntimeEngine !== "codex_cli" ||
      saving !== null ||
      chatGptConnection !== "connected" ||
      !codexCatalog.models
    )
      return;
    const compatible = intersectChatGptModels(
      engineCatalogModels,
      codexCatalog.models,
    ).some((model) => model.modelId === preferences.codexModel);
    if (!compatible) return;
    const route = `${OPENAI_CODEX_PROVIDER}/${preferences.codexModel}`;
    if (
      preferences.modelOverrides.orchestrator === route &&
      preferences.modelOverrides.general === route
    )
      return;
    const key = `${preferences.codexModel}:${preferences.modelOverrides.orchestrator ?? ""}:${preferences.modelOverrides.general ?? ""}`;
    if (migrationAttemptedRef.current === key) return;
    migrationAttemptedRef.current = key;
    const patch = {
      ...buildEngineRoutingPatch(
        preferences,
        "codex_cli",
        preferences.codexModel,
      ),
      ...buildEngineTransitionReasoningPatch(preferences, "codex_cli"),
    };
    void writePreferences(patch, "engine");
  }, [
    chatGptConnection,
    codexCatalog.models,
    engineCatalogModels,
    preferences,
    saving,
    writePreferences,
  ]);

  useEffect(() => {
    void load();
    const onExternalChange = () => {
      if (selfDispatchRef.current) {
        selfDispatchRef.current = false;
        return;
      }
      void load({ silent: true });
    };
    window.addEventListener(PREFS_EVENT, onExternalChange);
    return () => {
      window.removeEventListener(PREFS_EVENT, onExternalChange);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      if (oauthPendingRef.current) {
        void credentials.cancelOAuth(OPENAI_CODEX_PROVIDER);
      }
    };
    // `load` is stable for the panel's lifetime; avoid re-subscribing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── engine handlers ────────────────────────────────────────── */

  const saveEngine = useCallback(
    async (engine: AgentRuntimeEngine): Promise<boolean> => {
      if (!preferences) return false;
      if (
        engine === preferences.agentRuntimeEngine &&
        !(engine === "codex_cli" && chatGptConnection !== "connected")
      ) {
        return true;
      }
      setSaving("engine");
      try {
        if (engine === "codex_cli") {
          const selectedModel = preferences.codexModel;
          const available = codexCatalog.models
            ? intersectChatGptModels(engineCatalogModels, codexCatalog.models)
            : [];
          if (!available.some((model) => model.modelId === selectedModel)) {
            throw new Error(
              codexCatalog.error ??
                "Choose an available ChatGPT model before changing routes.",
            );
          }
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
        }
        const model =
          engine === "codex_cli"
            ? preferences.codexModel
            : engine === "claude_code_local"
              ? preferences.claudeCodeModel
              : undefined;
        const patch = {
          ...buildEngineRoutingPatch(preferences, engine, model),
          ...buildEngineTransitionReasoningPatch(preferences, engine),
        };
        const saved = await writePreferences(patch, "engine");
        return saved !== null;
      } catch (caught) {
        oauthPendingRef.current = false;
        showError(
          errorText(
            caught,
            engine === "codex_cli"
              ? "Could not connect ChatGPT."
              : "Could not change the engine.",
          ),
        );
        return false;
      } finally {
        setDraftEngine(null);
        setSaving(null);
      }
    },
    [
      chatGptConnection,
      codexCatalog.error,
      codexCatalog.models,
      credentials,
      engineCatalogModels,
      preferences,
      showError,
      writePreferences,
    ],
  );

  /* ── render ─────────────────────────────────────────────────── */

  return (
    <div className="right-sidebar__rich right-sidebar__rich--engine">
      <section className="engine-tab" aria-label="Model settings">
        <div className="engine-tab__engine-block">
          <div
            className="engine-tab__status-slot"
            role="status"
            aria-live="polite"
            data-kind={status?.kind ?? "idle"}
          >
            {status ? <span>{status.text}</span> : null}
          </div>

          <span className="engine-tab__engine-kicker">Engine</span>

          <EnginePickerPill
            className="engine-tab__engine-list"
            options={ENGINE_OPTIONS}
            value={selectedEngine}
            disabled={inputsDisabled}
            onChange={(engine) => {
              setDraftEngine(engine);
              void saveEngine(engine);
            }}
          />
          {selectedEngine === "codex_cli" &&
          chatGptConnection !== "connected" ? (
            <div className="engine-tab__connection" role="status">
              <span>
                {chatGptConnection === "needs-reauth"
                  ? "ChatGPT needs to be reconnected."
                  : chatGptConnection === "checking"
                    ? "Checking ChatGPT…"
                    : "ChatGPT is disconnected."}
              </span>
              {saving === "engine" && oauthPendingRef.current ? (
                <button
                  type="button"
                  onClick={() =>
                    void credentials.cancelOAuth(OPENAI_CODEX_PROVIDER)
                  }
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  disabled={inputsDisabled}
                  onClick={() => void saveEngine("codex_cli")}
                >
                  Connect
                </button>
              )}
            </div>
          ) : null}
        </div>

        <ModelsSection
          preferences={preferences}
          writePreferences={writePreferences}
          mediaTab={mediaTab}
          onMediaTabChange={setMediaTab}
          inputsDisabled={inputsDisabled}
          showNotice={showNotice}
          selectedEngine={selectedEngine}
          claudeCodeModels={claudeCodeModels}
          claudeCodeModelsLoading={claudeCodeModelsLoading}
          onRefreshClaudeCodeModels={() => void loadClaudeCodeModels()}
          chatGptConnected={chatGptConnection === "connected"}
        />
      </section>
    </div>
  );
}

/* ── Models section ───────────────────────────────────────────── */

interface ModelsSectionProps {
  preferences: LocalModelPreferences | null;
  writePreferences: (
    patch: Partial<LocalModelPreferences>,
    kind: SavingKind,
  ) => Promise<LocalModelPreferences | null>;
  mediaTab: MediaTab;
  onMediaTabChange: (tab: MediaTab) => void;
  inputsDisabled: boolean;
  showNotice: (text: string) => void;
  selectedEngine: AgentRuntimeEngine;
  claudeCodeModels: ClaudeCodeModelOption[];
  claudeCodeModelsLoading: boolean;
  onRefreshClaudeCodeModels: () => void;
  chatGptConnected: boolean;
}

function ModelsSection({
  preferences,
  writePreferences,
  mediaTab,
  onMediaTabChange,
  inputsDisabled,
  showNotice,
  selectedEngine,
  claudeCodeModels,
  claudeCodeModelsLoading,
  onRefreshClaudeCodeModels,
  chatGptConnected,
}: ModelsSectionProps) {
  const {
    models: stellaModels,
    allModels,
    defaults: stellaDefaultModels,
    groups,
    refresh,
    refreshing,
    audience,
  } = useModelCatalog();
  const codexCatalog = useCodexModelCatalog();

  const modelDefaults = useMemo(
    () =>
      preferences
        ? getLocalModelDefaults(preferences.defaultModels, stellaDefaultModels)
        : undefined,
    [preferences, stellaDefaultModels],
  );
  const overrides = useMemo(
    () =>
      preferences ? normalizeModelOverrides(preferences.modelOverrides) : {},
    [preferences],
  );
  const configurableAgents = useMemo(
    () => getConfigurableAgents(modelDefaults),
    [modelDefaults],
  );
  const defaultModelMap = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const resolvedDefaultModelMap = useMemo(
    () => buildResolvedModelDefaultsMap(modelDefaults),
    [modelDefaults],
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
  const runtimeModelEngine = usesRuntimeModelPicker(selectedEngine)
    ? selectedEngine
    : null;
  const batchAssignableAgents = useMemo(
    () =>
      configurableAgents.filter((entry) => entry.key !== CHRONICLE_AGENT_KEY),
    [configurableAgents],
  );
  const selectedStellaModelId =
    preferences?.modelOverrides[GENERAL_AGENT_KEY] ??
    preferences?.modelOverrides.orchestrator ??
    "";
  const stellaDefaultLabel =
    modelDefaults === undefined
      ? "Stella Default"
      : getDefaultModelOptionLabel(
          GENERAL_AGENT_KEY,
          defaultModelMap,
          resolvedDefaultModelMap,
          modelNamesById,
        );
  const selectedRuntimeModelId =
    runtimeModelEngine === "codex_cli"
      ? (preferences?.codexModel ?? DEFAULT_CODEX_MODEL)
      : runtimeModelEngine === "claude_code_local"
        ? (preferences?.claudeCodeModel ?? DEFAULT_CLAUDE_CODE_MODEL)
        : undefined;

  const codexRuntimeModels = useMemo(
    () =>
      (codexCatalog.models
        ? intersectChatGptModels(allModels, codexCatalog.models)
        : []
      ).map((model) => ({
        id: model.modelId,
        label: model.name || model.modelId,
        subtitle: model.modelId,
      })),
    [allModels, codexCatalog.models],
  );
  const codexCatalogSettled =
    !codexCatalog.loading && codexCatalog.models !== null;
  const selectedCodexModelUnavailable =
    runtimeModelEngine === "codex_cli" &&
    codexCatalogSettled &&
    Boolean(selectedRuntimeModelId) &&
    !codexRuntimeModels.some((model) => model.id === selectedRuntimeModelId);

  const claudeRuntimeModels = useMemo(
    () =>
      claudeCodeModels.map((model) => ({
        id: model.id,
        label: model.displayName || model.id,
        subtitle: model.source === "alias" ? model.description : model.id,
      })),
    [claudeCodeModels],
  );

  const activeRuntimeModels = useMemo(() => {
    const base =
      runtimeModelEngine === "codex_cli"
        ? codexRuntimeModels
        : runtimeModelEngine === "claude_code_local"
          ? claudeRuntimeModels
          : [];
    // A stale saved model (removed from the engine's list) would otherwise
    // render no row at all; pin it as a disabled "Unavailable" entry so the
    // configured value stays visible. Only once the list has loaded — an
    // empty base means loading/failed, not stale.
    if (
      !selectedRuntimeModelId ||
      (runtimeModelEngine === "codex_cli" && !codexCatalogSettled) ||
      base.some((model) => model.id === selectedRuntimeModelId)
    ) {
      return base;
    }
    return [
      ...base,
      {
        id: selectedRuntimeModelId,
        label: selectedRuntimeModelId,
        subtitle: "Unavailable",
        unavailable: true,
      },
    ];
  }, [
    claudeRuntimeModels,
    codexRuntimeModels,
    codexCatalogSettled,
    runtimeModelEngine,
    selectedRuntimeModelId,
  ]);

  const restricted = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  /* ── mutation handlers ─────────────────────────────────────── */

  const assignTo = useCallback(
    async (modelId: string, agentKeys: string[], effort: ReasoningEffort) => {
      if (!preferences || agentKeys.length === 0) return;
      const targetAgentKeys = agentKeys;
      if (targetAgentKeys.length === 0) return;
      const nextOverrides = { ...preferences.modelOverrides };
      const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
      const nextPropagated = new Set(
        preferences.assistantPropagatedAgents ?? [],
      );
      const nonStella = !isStellaModelId(modelId);
      for (const key of targetAgentKeys) {
        nextOverrides[key] = modelId;
        if (effort === "default") delete nextReasoning[key];
        else nextReasoning[key] = effort;
        if (nonStella && !CONVERSATION_AGENT_KEYS.has(key)) {
          nextPropagated.add(key);
        } else {
          nextPropagated.delete(key);
        }
      }
      const patch: Partial<LocalModelPreferences> = {
        modelOverrides: nextOverrides,
        reasoningEfforts: nextReasoning,
        assistantPropagatedAgents: Array.from(nextPropagated),
      };
      if (preferences.agentRuntimeEngine === "default") {
        const stellaModels = {
          ...(preferences.stellaConversationModelOverrides ?? {}),
        };
        const stellaReasoning = {
          ...(preferences.stellaConversationReasoningEfforts ?? {}),
        };
        for (const key of ["orchestrator", GENERAL_AGENT_KEY]) {
          if (nextOverrides[key]) stellaModels[key] = nextOverrides[key];
          else delete stellaModels[key];
          if (nextReasoning[key]) stellaReasoning[key] = nextReasoning[key];
          else delete stellaReasoning[key];
        }
        patch.stellaConversationModelOverrides = stellaModels;
        patch.stellaConversationReasoningEfforts = stellaReasoning;
      }
      if (modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX)) {
        const claudeCodeModel = fromRuntimeOverrideId(modelId);
        if (
          agentKeys.includes("orchestrator") ||
          agentKeys.includes(GENERAL_AGENT_KEY)
        ) {
          patch.claudeCodeModel = claudeCodeModel;
        }
      }
      await writePreferences(patch, "overrides");
    },
    [preferences, writePreferences],
  );

  const autoApplyModel = useCallback(
    async (
      modelId: string,
      runtimeEngine: RuntimeModelEngine | null = null,
    ) => {
      if (!preferences || !modelId) return;
      if (runtimeEngine === "codex_cli") {
        await writePreferences(
          buildEngineRoutingPatch(preferences, runtimeEngine, modelId),
          "overrides",
        );
        return;
      }
      if (runtimeEngine === "claude_code_local") {
        await writePreferences(
          buildEngineRoutingPatch(preferences, runtimeEngine, modelId),
          "overrides",
        );
        return;
      }
      const normalizedId = modelId;
      const agentKeys = batchAssignableAgents.map((entry) => entry.key);
      if (agentKeys.length === 0) return;
      // Preserve the current reasoning effort when switching models so a
      // model pick doesn't silently reset the user's reasoning choice.
      const effort =
        preferences.reasoningEfforts?.[GENERAL_AGENT_KEY] ??
        preferences.reasoningEfforts?.orchestrator ??
        "default";
      await assignTo(normalizedId, agentKeys, effort);
    },
    [assignTo, batchAssignableAgents, preferences, writePreferences],
  );

  const selectedReasoningEffort: ReasoningEffort =
    preferences?.reasoningEfforts?.[GENERAL_AGENT_KEY] ??
    preferences?.reasoningEfforts?.orchestrator ??
    "default";

  // Codex and Claude Code carry a single engine-wide effort (not per-agent):
  // Codex applies it as the turn `effort`, Claude Code as the CLI
  // `CLAUDE_CODE_EFFORT_LEVEL`.
  const selectedRuntimeReasoning: ReasoningEffort =
    runtimeModelEngine === "codex_cli"
      ? (preferences?.codexReasoningEffort ?? "default")
      : runtimeModelEngine === "claude_code_local"
        ? (preferences?.claudeCodeReasoningEffort ?? "default")
        : "default";

  // Selecting a thinking level on a runtime row both applies that model and
  // sets the engine-global effort, in one write so the UI doesn't flicker.
  const selectRuntimeReasoning = useCallback(
    async (modelId: string, effort: ReasoningEffort) => {
      if (!preferences || !runtimeModelEngine) return;
      const patch: Partial<LocalModelPreferences> = {
        ...buildEngineRoutingPatch(preferences, runtimeModelEngine, modelId),
        ...buildEngineReasoningPatch(preferences, runtimeModelEngine, effort, [
          "orchestrator",
          "general",
        ]),
      };
      await writePreferences(patch, "overrides");
    },
    [preferences, runtimeModelEngine, writePreferences],
  );

  // Per-row reasoning affordance: applies the model to the agent set at the
  // chosen reasoning effort, so the lightbulb doubles as a model+reasoning
  // pick (matching the "click a model to apply" picker semantics).
  const selectReasoning = useCallback(
    async (modelId: string, effort: ReasoningEffort) => {
      const agentKeys = batchAssignableAgents.map((entry) => entry.key);
      if (agentKeys.length === 0) return;
      await assignTo(modelId, agentKeys, effort);
    },
    [assignTo, batchAssignableAgents],
  );

  const clearStellaModelOverrides = useCallback(async () => {
    if (!preferences) return;
    const targetAgentKeys = batchAssignableAgents.map((entry) => entry.key);
    if (targetAgentKeys.length === 0) return;
    const nextOverrides = { ...preferences.modelOverrides };
    const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
    const nextPropagated = new Set(preferences.assistantPropagatedAgents ?? []);
    for (const key of targetAgentKeys) {
      delete nextOverrides[key];
      delete nextReasoning[key];
      nextPropagated.delete(key);
    }
    await writePreferences(
      {
        modelOverrides: nextOverrides,
        reasoningEfforts: nextReasoning,
        assistantPropagatedAgents: Array.from(nextPropagated),
        ...(preferences.agentRuntimeEngine === "default"
          ? {
              stellaConversationModelOverrides: {},
              stellaConversationReasoningEfforts: {},
            }
          : {}),
      },
      "overrides",
    );
  }, [batchAssignableAgents, preferences, writePreferences]);

  const handleResetAll = useCallback(async () => {
    if (!preferences) return;
    const next = await writePreferences(
      {
        modelOverrides: {},
        assistantPropagatedAgents: [],
        reasoningEfforts: {},
      },
      "overrides",
    );
    if (next) showNotice("Reset every agent");
  }, [preferences, showNotice, writePreferences]);

  /* ── image / voice handlers ──────────────────────────────── */

  const imagePreferences =
    preferences?.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
  const voicePreferences = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;

  const onImageProviderSelect = useCallback(
    async (providerKey: string) => {
      const next: ImageGenerationPreferences =
        providerKey === "openai"
          ? { provider: "openai" }
          : providerKey === "openrouter"
            ? { provider: "openrouter" }
            : providerKey === "fal"
              ? { provider: "fal" }
              : { provider: "stella" };
      await writePreferences({ imageGeneration: next }, "image");
    },
    [writePreferences],
  );

  const onUpdateVoice = useCallback(
    async (patch: Partial<RealtimeVoicePreferences>) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      await writePreferences(
        { realtimeVoice: { ...previous, ...patch } },
        "voice",
      );
    },
    [preferences, writePreferences],
  );

  /* ── render ──────────────────────────────────────────────── */

  const orchestratorCurrent = overrides.orchestrator ?? overrides.general ?? "";

  const runtimePanelLabel =
    runtimeModelEngine === "codex_cli" ? "ChatGPT" : "Claude Code";
  const runtimePanelFavoriteScope =
    runtimeModelEngine === "codex_cli" ? "engine:codex" : "engine:claude-code";
  const runtimePanelLoading =
    runtimeModelEngine === "codex_cli"
      ? codexCatalog.loading
      : claudeCodeModelsLoading;
  const runtimePanelRefresh =
    runtimeModelEngine === "codex_cli"
      ? () => void codexCatalog.refresh()
      : onRefreshClaudeCodeModels;
  const runtimePanelState =
    runtimeModelEngine !== "codex_cli"
      ? null
      : codexCatalog.error
        ? {
            kind: "error" as const,
            message: `ChatGPT models could not be verified: ${codexCatalog.error}`,
          }
        : codexCatalog.loading
          ? {
              kind: "status" as const,
              message: "Verifying ChatGPT models…",
            }
          : codexRuntimeModels.length === 0
            ? {
                kind: "status" as const,
                message:
                  "No models are currently available to both ChatGPT and Codex.",
              }
            : selectedCodexModelUnavailable
              ? {
                  kind: "status" as const,
                  message:
                    "The saved model is unavailable. Choose another model.",
                }
              : null;

  return (
    <div className="engine-tab__models">
      <div className="engine-tab__media-tabs-row">
        <nav
          className="engine-tab__media-tabs"
          role="tablist"
          aria-label="Media kind"
        >
          {MEDIA_TABS.map((tab) => {
            const selected = tab.id === mediaTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-selected={selected || undefined}
                className="engine-tab__media-tab"
                onClick={() => onMediaTabChange(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="engine-tab__kebab"
              title="More model actions"
              aria-label="More model actions"
            >
              <MoreHorizontal size={15} strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" sideOffset={6}>
            <DropdownMenuItem
              disabled={refreshing}
              onSelect={() => void refresh()}
            >
              <span data-slot="dropdown-menu-item-icon">
                <RefreshCw
                  size={14}
                  strokeWidth={1.75}
                  data-spinning={refreshing || undefined}
                />
              </span>
              Refresh model catalog
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!orchestratorCurrent || inputsDisabled}
              onSelect={() => void autoApplyModel(orchestratorCurrent, null)}
            >
              Apply orchestrator's model
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={inputsDisabled}
              onSelect={() => void handleResetAll()}
            >
              <span data-slot="dropdown-menu-item-icon">
                <RotateCcw size={14} strokeWidth={1.75} />
              </span>
              Reset every agent to default
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="engine-tab__models-pane" role="tabpanel">
        {mediaTab === "agents" ? (
          <div className="engine-tab__models-agents">
            {/* Keep both panels mounted and toggle visibility — flipping
             * the conditional unmounts/remounts the picker and visibly
             * jolts the surface every time the user switches engines.
             */}
            <div
              className="engine-tab__models-slot"
              data-active={runtimeModelEngine ? "runtime" : "default"}
            >
              <EngineRuntimeModelPanel
                providerLabel={runtimePanelLabel}
                models={activeRuntimeModels}
                selectedModelId={selectedRuntimeModelId}
                loading={runtimePanelLoading}
                disabled={
                  inputsDisabled ||
                  (runtimeModelEngine === "codex_cli" && !chatGptConnected) ||
                  (runtimeModelEngine === "codex_cli" &&
                    codexCatalog.models === null)
                }
                favoriteScope={runtimePanelFavoriteScope}
                onRefresh={runtimePanelRefresh}
                stateMessage={runtimePanelState?.message}
                stateKind={runtimePanelState?.kind}
                onSelectModel={(modelId) =>
                  void autoApplyModel(
                    modelId,
                    runtimeModelEngine ?? "codex_cli",
                  )
                }
                reasoningEffort={selectedRuntimeReasoning}
                onSelectReasoning={(modelId, effort) =>
                  void selectRuntimeReasoning(modelId, effort)
                }
              />
              <ProviderModelPanel
                value={selectedStellaModelId}
                defaultLabel={stellaDefaultLabel}
                currentLabel={
                  selectedStellaModelId
                    ? "Click a model to apply"
                    : stellaDefaultLabel
                }
                groups={groups}
                disabled={inputsDisabled}
                restrictStellaPicks={restricted}
                restrictedPlanLabel={restrictedPlanLabel}
                ariaLabel="Provider and model picker"
                selectedHeaderKicker="Tap a model"
                hideSelectedTitle
                hideSelectionCheck
                favoriteScope="engine:stella"
                reasoningEffort={selectedReasoningEffort}
                onSelectReasoning={(modelId, effort) =>
                  void selectReasoning(modelId, effort)
                }
                onSelect={(modelId) =>
                  modelId
                    ? void autoApplyModel(modelId, null)
                    : void clearStellaModelOverrides()
                }
              />
            </div>
          </div>
        ) : mediaTab === "image" ? (
          <ProviderOnlyPicker
            providers={IMAGE_PROVIDER_OPTIONS}
            value={imagePreferences.provider ?? "stella"}
            onSelect={(key) => void onImageProviderSelect(key)}
            disabled={inputsDisabled}
            ariaLabel="Image provider"
          />
        ) : (
          <div className="engine-tab__models-voice">
            <VoiceProviderPicker
              voice={voicePreferences}
              onUpdateVoice={(patch) => void onUpdateVoice(patch)}
              disabled={inputsDisabled}
            />
          </div>
        )}
      </div>
    </div>
  );
}
