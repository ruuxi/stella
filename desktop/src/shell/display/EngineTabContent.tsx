/**
 * Engine tab — the workspace panel's home for everything model & runtime.
 *
 * Replaces the old Settings → Models page. Single surface covers:
 *
 *   - Picking the agent runtime engine (Stella / Codex / Claude Code) and
 *     Codex reasoning when Codex is selected.
 *   - Cursor is a provider under Agents (API key + model), not an engine.
 *   - Assigning a Stella / Codex / Claude Code model across the agent set
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
import { MoreHorizontal, RefreshCw, RotateCcw } from "lucide-react";
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
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { getStellaDisplayName } from "@/global/settings/lib/model-catalog";
import { CURSOR_MODEL_PREFIX } from "@/global/settings/lib/llm-providers";
import { DEFAULT_CURSOR_MODEL } from "@/shell/display/engine-tab-constants";
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
} from "@/shared/billing/audience";
import {
  coerceRealtimeVoiceProvider,
  type ReadAloudVoiceProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceUnderlyingProvider,
} from "../../../../runtime/contracts/local-preferences";
import { EngineRuntimeModelPanel } from "./EngineRuntimeModelPanel";
import "./engine-tab.css";

/* ── types ────────────────────────────────────────────────────── */

type AgentRuntimeEngine =
  | "default"
  | "claude_code_local"
  | "cursor_sdk"
  | "codex_cli";

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
  agentRuntimeEngine: AgentRuntimeEngine;
  cursorModel: string;
  codexModel: string;
  codexReasoningEffort: CodexReasoningPreference;
  claudeCodeModel: string;
  claudeCodeReasoningEffort: ReasoningEffort;
  maxAgentConcurrency: number;
  imageGeneration: ImageGenerationPreferences;
  realtimeVoice: RealtimeVoicePreferences;
};

type CursorModelOption = {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
};

type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: CodexReasoningEffort;
    description: string;
  }>;
  defaultReasoningEffort: CodexReasoningEffort;
  inputModalities: string[];
  additionalSpeedTiers: string[];
  isDefault: boolean;
};

type ClaudeCodeModelOption = {
  id: string;
  displayName: string;
  source: "alias" | "anthropic";
};

type MediaTab = "agents" | "image" | "voice";

type SavingKind =
  | "engine"
  | "key"
  | "cursor-model"
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
  { id: "codex_cli", label: "Codex" },
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

const DEFAULT_IMAGE_GENERATION: ImageGenerationPreferences = {
  provider: "stella",
};
const DEFAULT_REALTIME_VOICE: RealtimeVoicePreferences = {
  provider: "stella",
};

const DEFAULT_CODEX_MODEL = "gpt-5.5";
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
const CODEX_MODEL_PREFIX = "codex-cli/";
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

const toRuntimeOverrideId = (
  engine: RuntimeModelEngine,
  modelId: string,
): string => {
  const prefix =
    engine === "codex_cli" ? CODEX_MODEL_PREFIX : CLAUDE_CODE_MODEL_PREFIX;
  return modelId.startsWith(prefix) ? modelId : `${prefix}${modelId}`;
};

const isCursorModelId = (modelId: string): boolean =>
  modelId.startsWith(CURSOR_MODEL_PREFIX);

const fromRuntimeOverrideId = (modelId: string): string => {
  if (modelId.startsWith(CODEX_MODEL_PREFIX)) {
    return modelId.slice(CODEX_MODEL_PREFIX.length);
  }
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
  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    () => cachedPreferences,
  );
  const [hasCursorApiKey, setHasCursorApiKey] = useState(false);
  const [cursorModels, setCursorModels] = useState<CursorModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [codexModelsLoading, setCodexModelsLoading] = useState(false);
  const [claudeCodeModels, setClaudeCodeModels] = useState<
    ClaudeCodeModelOption[]
  >([]);
  const [claudeCodeModelsLoading, setClaudeCodeModelsLoading] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [cursorModelDraft, setCursorModelDraft] =
    useState(DEFAULT_CURSOR_MODEL);
  const [loading, setLoading] = useState(() => cachedPreferences === null);
  const [saving, setSaving] = useState<SavingKind>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [mediaTab, setMediaTab] = useState<MediaTab>("agents");

  const selfDispatchRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const cursorModelsLoadedRef = useRef(false);
  const codexModelsLoadedRef = useRef(false);
  const claudeCodeModelsLoadedRef = useRef(false);

  const selectedEngine = preferences?.agentRuntimeEngine ?? "default";
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
    (
      saved: LocalModelPreferences | null | undefined,
      { resetEngineDrafts }: { resetEngineDrafts: boolean },
    ) => {
      if (!saved) return;
      let next: LocalModelPreferences = {
        ...saved,
        cursorModel: saved.cursorModel || DEFAULT_CURSOR_MODEL,
        codexModel: saved.codexModel || DEFAULT_CODEX_MODEL,
        codexReasoningEffort:
          saved.codexReasoningEffort || DEFAULT_CODEX_REASONING,
        claudeCodeModel: saved.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL,
        claudeCodeReasoningEffort:
          saved.claudeCodeReasoningEffort || DEFAULT_CLAUDE_CODE_REASONING,
      };
      if (next.agentRuntimeEngine === "cursor_sdk") {
        const generalOverride = next.modelOverrides[GENERAL_AGENT_KEY];
        next = {
          ...next,
          agentRuntimeEngine: "default",
          modelOverrides: {
            ...next.modelOverrides,
            ...(generalOverride?.startsWith(CURSOR_MODEL_PREFIX)
              ? {}
              : {
                  [GENERAL_AGENT_KEY]: `${CURSOR_MODEL_PREFIX}${next.cursorModel}`,
                }),
          },
        };
        void window.electronAPI?.system?.setLocalModelPreferences?.({
          agentRuntimeEngine: "default",
          modelOverrides: next.modelOverrides,
        });
      }
      cachedPreferences = next;
      setPreferences(next);
      if (resetEngineDrafts) {
        setCursorModelDraft((current) =>
          current === next.cursorModel ? current : next.cursorModel,
        );
      }
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
      const markSaving = kind !== "overrides" && kind !== "engine";
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

  const loadCursorModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const result = await window.electronAPI?.system?.listCursorModels?.();
      setCursorModels(result?.models ?? []);
      if ((result?.models ?? []).length > 0) {
        cursorModelsLoadedRef.current = true;
      }
    } catch (caught) {
      showError(errorText(caught, "Cursor models did not load."));
    } finally {
      setModelsLoading(false);
    }
  }, [showError]);

  const loadCodexModels = useCallback(async () => {
    setCodexModelsLoading(true);
    try {
      const result = await window.electronAPI?.system?.listCodexModels?.();
      setCodexModels(result?.models ?? []);
      codexModelsLoadedRef.current = true;
    } catch (caught) {
      showError(errorText(caught, "Codex models did not load."));
    } finally {
      setCodexModelsLoading(false);
    }
  }, [showError]);

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
        const [prefs, keyStatus] = await Promise.all([
          window.electronAPI?.system?.getLocalModelPreferences?.(),
          window.electronAPI?.system?.getCursorApiKeyStatus?.(),
        ]);
        applySavedPrefs(prefs as LocalModelPreferences | undefined, {
          resetEngineDrafts: !options?.silent,
        });
        if (
          prefs?.agentRuntimeEngine === "codex_cli" &&
          !codexModelsLoadedRef.current
        ) {
          void loadCodexModels();
        }
        if (
          prefs?.agentRuntimeEngine === "claude_code_local" &&
          !claudeCodeModelsLoadedRef.current
        ) {
          void loadClaudeCodeModels();
        }
        const nextHasKey = Boolean(keyStatus?.hasApiKey);
        setHasCursorApiKey(nextHasKey);
        if (nextHasKey && !cursorModelsLoadedRef.current) {
          void loadCursorModels();
        } else if (!nextHasKey) {
          setCursorModels([]);
          cursorModelsLoadedRef.current = false;
        }
      } catch (caught) {
        showError(errorText(caught, "Engine settings did not load."));
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [
      applySavedPrefs,
      loadClaudeCodeModels,
      loadCodexModels,
      loadCursorModels,
      showError,
    ],
  );

  useEffect(() => {
    if (selectedEngine === "codex_cli" && !codexModelsLoadedRef.current) {
      void loadCodexModels();
    }
    if (
      selectedEngine === "claude_code_local" &&
      !claudeCodeModelsLoadedRef.current
    ) {
      void loadClaudeCodeModels();
    }
  }, [loadClaudeCodeModels, loadCodexModels, selectedEngine]);

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
    };
    // `load` is stable for the panel's lifetime; avoid re-subscribing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── engine handlers ────────────────────────────────────────── */

  const saveEngine = useCallback(
    async (engine: AgentRuntimeEngine) => {
      if (!preferences || engine === preferences.agentRuntimeEngine) return;
      await writePreferences({ agentRuntimeEngine: engine }, "engine");
    },
    [preferences, writePreferences],
  );

  const saveCursorApiKey = useCallback(async () => {
    setSaving("key");
    clearStatus();
    try {
      const saved = await window.electronAPI?.system?.setCursorApiKey?.({
        apiKey: apiKeyDraft,
      });
      const nextHasKey = Boolean(saved?.hasApiKey);
      setHasCursorApiKey(nextHasKey);
      setApiKeyDraft("");
      showNotice(nextHasKey ? "Cursor key saved" : "Cursor key removed");
      if (nextHasKey) {
        cursorModelsLoadedRef.current = false;
        void loadCursorModels();
      } else {
        setCursorModels([]);
        cursorModelsLoadedRef.current = false;
      }
    } catch (caught) {
      showError(errorText(caught, "Cursor key was not saved."));
    } finally {
      setSaving(null);
    }
  }, [apiKeyDraft, clearStatus, loadCursorModels, showError, showNotice]);

  const saveCursorModel = useCallback(
    async (modelId?: string) => {
      if (!preferences) return;
      const nextModel =
        (modelId ?? cursorModelDraft).trim() || DEFAULT_CURSOR_MODEL;
      const overrideId = `${CURSOR_MODEL_PREFIX}${nextModel}`;
      if (
        nextModel === preferences.cursorModel &&
        preferences.modelOverrides[GENERAL_AGENT_KEY] === overrideId
      ) {
        return;
      }
      const nextOverrides = { ...preferences.modelOverrides };
      const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
      const nextPropagated = new Set(
        preferences.assistantPropagatedAgents ?? [],
      );
      for (const [key, value] of Object.entries(nextOverrides)) {
        if (key !== GENERAL_AGENT_KEY && isCursorModelId(value)) {
          delete nextOverrides[key];
          delete nextReasoning[key];
          nextPropagated.delete(key);
        }
      }
      nextOverrides[GENERAL_AGENT_KEY] = overrideId;
      const next = await writePreferences(
        {
          cursorModel: nextModel,
          modelOverrides: nextOverrides,
          reasoningEfforts: nextReasoning,
          assistantPropagatedAgents: Array.from(nextPropagated),
        },
        "cursor-model",
      );
      if (next) {
        setCursorModelDraft(next.cursorModel);
        showNotice("Cursor model saved");
      }
    },
    [cursorModelDraft, preferences, showNotice, writePreferences],
  );

  /* ── render ─────────────────────────────────────────────────── */

  return (
    <div className="display-sidebar__rich display-sidebar__rich--engine">
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

          <div
            className="engine-tab__engine-list"
            role="radiogroup"
            aria-label="Model engine"
          >
            {ENGINE_OPTIONS.map((option) => {
              const selected = option.id === selectedEngine;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-selected={selected || undefined}
                  className="engine-tab__engine-option"
                  disabled={inputsDisabled}
                  onClick={() => void saveEngine(option.id)}
                >
                  <span className="engine-tab__engine-label">
                    {option.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <ModelsSection
          preferences={preferences}
          writePreferences={writePreferences}
          mediaTab={mediaTab}
          onMediaTabChange={setMediaTab}
          inputsDisabled={inputsDisabled}
          showNotice={showNotice}
          selectedEngine={selectedEngine}
          codexModels={codexModels}
          codexModelsLoading={codexModelsLoading}
          onRefreshCodexModels={() => void loadCodexModels()}
          claudeCodeModels={claudeCodeModels}
          claudeCodeModelsLoading={claudeCodeModelsLoading}
          onRefreshClaudeCodeModels={() => void loadClaudeCodeModels()}
          hasCursorApiKey={hasCursorApiKey}
          cursorModels={cursorModels}
          cursorModelsLoading={modelsLoading}
          cursorModelDraft={cursorModelDraft}
          apiKeyDraft={apiKeyDraft}
          saving={saving}
          onApiKeyDraftChange={setApiKeyDraft}
          onCursorModelDraftChange={setCursorModelDraft}
          onSaveCursorApiKey={() => void saveCursorApiKey()}
          onSaveCursorModel={(id) => void saveCursorModel(id)}
          onRefreshCursorModels={() => void loadCursorModels()}
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
  codexModels: CodexModelOption[];
  codexModelsLoading: boolean;
  onRefreshCodexModels: () => void;
  claudeCodeModels: ClaudeCodeModelOption[];
  claudeCodeModelsLoading: boolean;
  onRefreshClaudeCodeModels: () => void;
  hasCursorApiKey: boolean;
  cursorModels: CursorModelOption[];
  cursorModelsLoading: boolean;
  cursorModelDraft: string;
  apiKeyDraft: string;
  saving: SavingKind;
  onApiKeyDraftChange: (value: string) => void;
  onCursorModelDraftChange: (value: string) => void;
  onSaveCursorApiKey: () => void;
  onSaveCursorModel: (modelId?: string) => void;
  onRefreshCursorModels: () => void;
}

function ModelsSection({
  preferences,
  writePreferences,
  mediaTab,
  onMediaTabChange,
  inputsDisabled,
  showNotice,
  selectedEngine,
  codexModels,
  codexModelsLoading,
  onRefreshCodexModels,
  claudeCodeModels,
  claudeCodeModelsLoading,
  onRefreshClaudeCodeModels,
  hasCursorApiKey,
  cursorModels,
  cursorModelsLoading,
  cursorModelDraft,
  apiKeyDraft,
  saving,
  onApiKeyDraftChange,
  onCursorModelDraftChange,
  onSaveCursorApiKey,
  onSaveCursorModel,
  onRefreshCursorModels,
}: ModelsSectionProps) {
  const {
    models: stellaModels,
    defaults: stellaDefaultModels,
    groups,
    refresh,
    refreshing,
    audience,
  } = useModelCatalog();

  const modelDefaults = useMemo(
    () =>
      preferences
        ? getLocalModelDefaults(preferences.defaultModels, stellaDefaultModels)
        : undefined,
    [preferences, stellaDefaultModels],
  );
  const overrides = useMemo(
    () =>
      preferences
        ? normalizeModelOverrides(preferences.modelOverrides)
        : {},
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
  const selectedCursorModelId =
    preferences?.cursorModel ?? DEFAULT_CURSOR_MODEL;
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
      codexModels.map((model) => ({
        id: model.id,
        label: model.displayName || model.id,
        subtitle: model.model,
      })),
    [codexModels],
  );

  const claudeRuntimeModels = useMemo(
    () =>
      claudeCodeModels.map((model) => ({
        id: model.id,
        label: model.displayName || model.id,
        subtitle: model.source === "alias" ? undefined : model.id,
      })),
    [claudeCodeModels],
  );

  const activeRuntimeModels =
    runtimeModelEngine === "codex_cli"
      ? codexRuntimeModels
      : runtimeModelEngine === "claude_code_local"
        ? claudeRuntimeModels
        : [];

  const restricted = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  /* ── mutation handlers ─────────────────────────────────────── */

  const assignTo = useCallback(
    async (modelId: string, agentKeys: string[], effort: ReasoningEffort) => {
      if (!preferences || agentKeys.length === 0) return;
      const targetAgentKeys = isCursorModelId(modelId)
        ? agentKeys.filter((key) => key === GENERAL_AGENT_KEY)
        : agentKeys;
      if (targetAgentKeys.length === 0) return;
      const nextOverrides = { ...preferences.modelOverrides };
      const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
      const nextPropagated = new Set(
        preferences.assistantPropagatedAgents ?? [],
      );
      if (isCursorModelId(modelId)) {
        for (const [key, value] of Object.entries(nextOverrides)) {
          if (key !== GENERAL_AGENT_KEY && isCursorModelId(value)) {
            delete nextOverrides[key];
            delete nextReasoning[key];
            nextPropagated.delete(key);
          }
        }
      }
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
      if (modelId.startsWith(CODEX_MODEL_PREFIX)) {
        const codexModel = fromRuntimeOverrideId(modelId);
        if (
          agentKeys.includes("orchestrator") ||
          agentKeys.includes(GENERAL_AGENT_KEY)
        ) {
          patch.codexModel = codexModel;
        }
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
      if (isCursorModelId(modelId)) {
        const cursorModel = modelId.slice(CURSOR_MODEL_PREFIX.length);
        patch.cursorModel = cursorModel || DEFAULT_CURSOR_MODEL;
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
      const normalizedId = runtimeEngine
        ? toRuntimeOverrideId(runtimeEngine, modelId)
        : modelId;
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
    [assignTo, batchAssignableAgents, preferences],
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
      const normalizedId = toRuntimeOverrideId(runtimeModelEngine, modelId);
      const agentKeys = batchAssignableAgents.map((entry) => entry.key);
      if (agentKeys.length === 0) return;
      const nextOverrides = { ...preferences.modelOverrides };
      const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
      const nextPropagated = new Set(
        preferences.assistantPropagatedAgents ?? [],
      );
      for (const key of agentKeys) {
        nextOverrides[key] = normalizedId;
        // Runtime engines use the engine-global effort, not per-agent.
        delete nextReasoning[key];
        if (CONVERSATION_AGENT_KEYS.has(key)) nextPropagated.delete(key);
        else nextPropagated.add(key);
      }
      const bareModel = fromRuntimeOverrideId(normalizedId);
      const patch: Partial<LocalModelPreferences> = {
        modelOverrides: nextOverrides,
        reasoningEfforts: nextReasoning,
        assistantPropagatedAgents: Array.from(nextPropagated),
      };
      if (runtimeModelEngine === "codex_cli") {
        patch.codexModel = bareModel;
        patch.codexReasoningEffort = effort as CodexReasoningPreference;
      } else {
        patch.claudeCodeModel = bareModel;
        patch.claudeCodeReasoningEffort = effort;
      }
      await writePreferences(patch, "overrides");
    },
    [batchAssignableAgents, preferences, runtimeModelEngine, writePreferences],
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

  const onVoiceProviderSelect = useCallback(
    async (providerKey: string) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
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
      await writePreferences({ realtimeVoice: next }, "voice");
    },
    [preferences, writePreferences],
  );

  const onVoiceSelect = useCallback(
    async (
      underlyingProvider: RealtimeVoiceUnderlyingProvider,
      voiceId: string,
    ) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      await writePreferences(
        {
          realtimeVoice: {
            ...previous,
            voices: {
              ...(previous.voices ?? {}),
              [underlyingProvider]: voiceId,
            },
          },
        },
        "voice",
      );
    },
    [preferences, writePreferences],
  );

  const onVoiceSubProviderSelect = useCallback(
    async (sub: RealtimeVoiceUnderlyingProvider) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      if (previous.stellaSubProvider === sub) return;
      await writePreferences(
        { realtimeVoice: { ...previous, stellaSubProvider: sub } },
        "voice",
      );
    },
    [preferences, writePreferences],
  );

  const onInworldSpeedSelect = useCallback(
    async (speed: number) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      const clamped = Math.min(2.0, Math.max(0.5, speed));
      if (
        typeof previous.inworldSpeed === "number" &&
        Math.abs(previous.inworldSpeed - clamped) < 0.001
      ) {
        return;
      }
      await writePreferences(
        { realtimeVoice: { ...previous, inworldSpeed: clamped } },
        "voice",
      );
    },
    [preferences, writePreferences],
  );

  const onReadAloudProviderSelect = useCallback(
    async (provider: ReadAloudVoiceProvider) => {
      const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      if ((previous.readAloudProvider ?? "inworld") === provider) return;
      await writePreferences(
        { realtimeVoice: { ...previous, readAloudProvider: provider } },
        "voice",
      );
    },
    [preferences, writePreferences],
  );

  /* ── render ──────────────────────────────────────────────── */

  const orchestratorCurrent = overrides.orchestrator ?? overrides.general ?? "";

  const runtimePanelLabel =
    runtimeModelEngine === "codex_cli" ? "Codex" : "Claude Code";
  const runtimePanelFavoriteScope =
    runtimeModelEngine === "codex_cli" ? "engine:codex" : "engine:claude-code";
  const runtimePanelLoading =
    runtimeModelEngine === "codex_cli"
      ? codexModelsLoading
      : claudeCodeModelsLoading;
  const runtimePanelRefresh =
    runtimeModelEngine === "codex_cli"
      ? onRefreshCodexModels
      : onRefreshClaudeCodeModels;

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
                disabled={inputsDisabled}
                favoriteScope={runtimePanelFavoriteScope}
                onRefresh={runtimePanelRefresh}
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
                favoriteScope="engine:stella"
                cursorProvider={{
                  hasApiKey: hasCursorApiKey,
                  models: cursorModels,
                  modelsLoading: cursorModelsLoading,
                  selectedModelId: selectedCursorModelId,
                  apiKeyDraft,
                  modelDraft: cursorModelDraft,
                  savingKey: saving === "key",
                  savingModel: saving === "cursor-model",
                  onApiKeyDraftChange,
                  onModelDraftChange: onCursorModelDraftChange,
                  onSaveApiKey: onSaveCursorApiKey,
                  onRefreshModels: onRefreshCursorModels,
                  onPickModel: (modelId) =>
                    void autoApplyModel(
                      modelId.startsWith(CURSOR_MODEL_PREFIX)
                        ? modelId
                        : `${CURSOR_MODEL_PREFIX}${modelId}`,
                      null,
                    ),
                  onSaveManualModel: () => onSaveCursorModel(),
                }}
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
            <ProviderOnlyPicker
              providers={VOICE_PROVIDER_OPTIONS}
              value={voicePreferences.provider ?? "stella"}
              onSelect={(key) => void onVoiceProviderSelect(key)}
              disabled={inputsDisabled}
              ariaLabel="Voice provider"
            />
            <VoiceCatalogPicker
              voiceProvider={voicePreferences.provider}
              stellaSubProvider={voicePreferences.stellaSubProvider}
              selectedVoices={voicePreferences.voices}
              inworldSpeed={voicePreferences.inworldSpeed}
              readAloudProvider={voicePreferences.readAloudProvider}
              onSelectVoice={(underlying, voiceId) =>
                void onVoiceSelect(underlying, voiceId)
              }
              onSelectStellaSubProvider={(sub) =>
                void onVoiceSubProviderSelect(sub)
              }
              onSelectInworldSpeed={(speed) => void onInworldSpeedSelect(speed)}
              onSelectReadAloudProvider={(provider) =>
                void onReadAloudProviderSelect(provider)
              }
              disabled={inputsDisabled}
            />
          </div>
        )}
      </div>
    </div>
  );
}

