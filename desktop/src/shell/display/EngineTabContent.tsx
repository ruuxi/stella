/**
 * Engine tab — the workspace panel's home for everything model & runtime.
 *
 * Replaces the old Settings → Models page. Single surface covers:
 *
 *   - Picking the agent runtime engine (Stella / Codex / Claude Code) and
 *     Codex reasoning when Codex is selected.
 *   - Cursor is a provider under Agents (API key + model), not an engine.
 *   - Assigning a specific Stella / BYOK model to one or more agents, at
 *     a chosen reasoning effort, via the inline ProviderModelPanel +
 *     assignment popover.
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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, RefreshCw, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Button } from "@/ui/button";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import {
  ProviderOnlyPicker,
  type ProviderOption,
} from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import {
  findApiKey,
  findOauthCredential,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { getStellaDisplayName } from "@/global/settings/lib/model-catalog";
import {
  compareProviderRailOrder,
  CURSOR_MODEL_PREFIX,
  LLM_PROVIDERS,
} from "@/global/settings/lib/llm-providers";
import { DEFAULT_CURSOR_MODEL } from "@/shell/display/engine-tab-constants";
import {
  buildModelDefaultsMap,
  getConfigurableAgents,
  getLocalModelDefaults,
  normalizeModelOverrides,
} from "@/global/settings/lib/model-defaults";
import {
  getPlanLabel,
  isRestrictedModelOverrideAudience,
} from "@/shared/billing/audience";
import {
  coerceRealtimeVoiceProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceUnderlyingProvider,
} from "../../../../runtime/contracts/local-preferences";
import { useT } from "@/shared/i18n";
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
      cachedPreferences = optimistic;
      setPreferences(optimistic);
      setSaving(kind);
      clearStatus();
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        const next = (saved as LocalModelPreferences | undefined) ?? optimistic;
        cachedPreferences = next;
        setPreferences(next);
        notifyPrefsChanged();
        return next;
      } catch (caught) {
        cachedPreferences = previous;
        setPreferences(previous);
        showError(errorText(caught, "Could not save model setting."));
        return null;
      } finally {
        setSaving(null);
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
          <header className="engine-tab__header">
            <h3 className="engine-tab__title">Model</h3>
          </header>

          <div
            className="engine-tab__status-slot"
            role="status"
            aria-live="polite"
            data-kind={status?.kind ?? "idle"}
          >
            {status ? <span>{status.text}</span> : null}
          </div>

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
                  <span className="engine-tab__engine-label">{option.label}</span>
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

        <ConnectedProvidersSection />
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
  const defaultModelMap = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const overrides = useMemo(
    () =>
      preferences
        ? normalizeModelOverrides(preferences.modelOverrides, defaultModelMap)
        : {},
    [preferences, defaultModelMap],
  );
  const configurableAgents = useMemo(
    () => getConfigurableAgents(modelDefaults),
    [modelDefaults],
  );
  const runtimeModelEngine = usesRuntimeModelPicker(selectedEngine)
    ? selectedEngine
    : null;
  const popoverAgents = configurableAgents;
  const selectedCursorModelId =
    preferences?.cursorModel ?? DEFAULT_CURSOR_MODEL;

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

  const modelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const model of stellaModels) {
      const label =
        model.provider === "stella" ? getStellaDisplayName(model) : model.name;
      next.set(model.id, label);
      if (model.upstreamModel) next.set(model.upstreamModel, label);
    }
    for (const model of activeRuntimeModels) {
      if (!runtimeModelEngine) continue;
      next.set(toRuntimeOverrideId(runtimeModelEngine, model.id), model.label);
      next.set(model.id, model.label);
    }
    for (const model of cursorModels) {
      const overrideId = `${CURSOR_MODEL_PREFIX}${model.id}`;
      next.set(overrideId, model.displayName || model.id);
      next.set(model.id, model.displayName || model.id);
    }
    return next;
  }, [activeRuntimeModels, cursorModels, runtimeModelEngine, stellaModels]);

  const restricted = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  /* ── assignment popover ───────────────────────────────────── */

  type AssignmentState = {
    modelId: string;
    rect: DOMRect;
    initialReasoning: ReasoningEffort;
    initialAgents: string[];
    runtimeEngine: RuntimeModelEngine | null;
  };
  const [assignment, setAssignment] = useState<AssignmentState | null>(null);

  const closeAssignment = useCallback(() => {
    setAssignment(null);
  }, []);

  const agentsByModel = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of popoverAgents) {
      const current = overrides[entry.key];
      if (!current) continue;
      const list = map.get(current);
      if (list) list.push(entry.key);
      else map.set(current, [entry.key]);
    }
    return map;
  }, [overrides, popoverAgents]);

  const handleOpenAssignment = useCallback(
    (
      modelId: string,
      anchorEl?: HTMLElement | null,
      runtimeEngine: RuntimeModelEngine | null = null,
    ) => {
      if (!modelId) return;
      const normalizedId = runtimeEngine
        ? toRuntimeOverrideId(runtimeEngine, modelId)
        : modelId;
      const rect = anchorEl?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const initialAgents = isCursorModelId(normalizedId)
        ? [GENERAL_AGENT_KEY]
        : (agentsByModel.get(normalizedId) ?? []);
      const reasoningCandidates = new Set<ReasoningEffort>();
      for (const key of initialAgents) {
        reasoningCandidates.add(
          preferences?.reasoningEfforts?.[key] ?? "default",
        );
      }
      const initialReasoning: ReasoningEffort =
        reasoningCandidates.size === 1
          ? Array.from(reasoningCandidates)[0]
          : "default";
      // Defer one frame so the opening click doesn't immediately dismiss
      // the overlay/backdrop listener on the same event turn.
      window.requestAnimationFrame(() => {
        setAssignment({
          modelId: normalizedId,
          rect,
          initialReasoning,
          initialAgents,
          runtimeEngine,
        });
      });
    },
    [agentsByModel, preferences],
  );

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

  const clearAgents = useCallback(
    async (agentKeys: string[]) => {
      if (!preferences || agentKeys.length === 0) return;
      const nextOverrides = { ...preferences.modelOverrides };
      const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
      const nextPropagated = (
        preferences.assistantPropagatedAgents ?? []
      ).filter((key) => !agentKeys.includes(key));
      for (const key of agentKeys) {
        delete nextOverrides[key];
        delete nextReasoning[key];
      }
      await writePreferences(
        {
          modelOverrides: nextOverrides,
          reasoningEfforts: nextReasoning,
          assistantPropagatedAgents: nextPropagated,
        },
        "overrides",
      );
    },
    [preferences, writePreferences],
  );

  const applyAssignment = useCallback(
    async (modelId: string, agentKeys: string[], effort: ReasoningEffort) => {
      if (!preferences) {
        closeAssignment();
        return;
      }
      const previouslyAssigned = agentsByModel.get(modelId) ?? [];
      const toClear = previouslyAssigned.filter(
        (key) => !agentKeys.includes(key),
      );
      if (toClear.length > 0) await clearAgents(toClear);
      if (agentKeys.length > 0) await assignTo(modelId, agentKeys, effort);
      closeAssignment();
      showNotice("Models updated");
    },
    [
      agentsByModel,
      assignTo,
      clearAgents,
      closeAssignment,
      preferences,
      showNotice,
    ],
  );

  const applyToAll = useCallback(
    async (modelId: string, effort: ReasoningEffort) => {
      if (!preferences || isCursorModelId(modelId)) {
        closeAssignment();
        return;
      }
      const allKeys = popoverAgents.map((entry) => entry.key);
      await assignTo(modelId, allKeys, effort);
      closeAssignment();
      showNotice("Applied to every agent");
    },
    [assignTo, closeAssignment, popoverAgents, preferences, showNotice],
  );

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
              onSelect={() =>
                void assignTo(
                  orchestratorCurrent,
                  configurableAgents.map((entry) => entry.key),
                  preferences?.reasoningEfforts?.orchestrator ?? "default",
                )
              }
            >
              Apply orchestrator's model to all
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
                loading={runtimePanelLoading}
                disabled={inputsDisabled}
                favoriteScope={runtimePanelFavoriteScope}
                onRefresh={runtimePanelRefresh}
                onSelectModel={(modelId, anchor) =>
                  handleOpenAssignment(
                    modelId,
                    anchor,
                    runtimeModelEngine ?? "codex_cli",
                  )
                }
              />
              <ProviderModelPanel
                value=""
                defaultLabel=""
                currentLabel="Click a model to assign"
                groups={groups}
                disabled={inputsDisabled}
                restrictStellaPicks={restricted}
                restrictedPlanLabel={restrictedPlanLabel}
                ariaLabel="Provider and model picker"
                hideDefaultRow
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
                  onPickModel: (modelId, anchor) =>
                    handleOpenAssignment(
                      modelId.startsWith(CURSOR_MODEL_PREFIX)
                        ? modelId
                        : `${CURSOR_MODEL_PREFIX}${modelId}`,
                      anchor ?? null,
                      null,
                    ),
                  onSaveManualModel: () => onSaveCursorModel(),
                }}
                onSelect={(modelId, anchor) =>
                  handleOpenAssignment(modelId, anchor ?? null, null)
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
              onSelectVoice={(underlying, voiceId) =>
                void onVoiceSelect(underlying, voiceId)
              }
              onSelectStellaSubProvider={(sub) =>
                void onVoiceSubProviderSelect(sub)
              }
              onSelectInworldSpeed={(speed) => void onInworldSpeedSelect(speed)}
              disabled={inputsDisabled}
            />
          </div>
        )}
      </div>

      {assignment ? (
        <AssignmentPopover
          assignment={assignment}
          configurableAgents={
            isCursorModelId(assignment.modelId)
              ? popoverAgents.filter(
                  (entry) => entry.key === GENERAL_AGENT_KEY,
                )
              : popoverAgents
          }
          overrides={overrides}
          reasoningEfforts={preferences?.reasoningEfforts ?? {}}
          modelNamesById={modelNamesById}
          pending={inputsDisabled}
          onApply={(agents, effort) =>
            void applyAssignment(
              assignment.modelId,
              isCursorModelId(assignment.modelId)
                ? [GENERAL_AGENT_KEY]
                : agents,
              effort,
            )
          }
          onApplyToAll={(effort) => void applyToAll(assignment.modelId, effort)}
          onClose={closeAssignment}
        />
      ) : null}
    </div>
  );
}

/* ── Connected providers section ─────────────────────────────── */

function ConnectedProvidersSection() {
  const t = useT();
  const credentials = useLlmCredentials();
  const [removingProvider, setRemovingProvider] = useState<string | null>(null);

  const connectedProviders = useMemo(() => {
    const rows = LLM_PROVIDERS.map((entry) => {
      const apiKey = findApiKey(credentials.apiKeys, entry.key);
      const oauth = findOauthCredential(
        credentials.oauthCredentials,
        entry.key,
      );
      if (!apiKey && !oauth) return null;
      return { ...entry, apiKey, oauth };
    }).filter(Boolean) as Array<
      (typeof LLM_PROVIDERS)[number] & {
        apiKey: ReturnType<typeof findApiKey>;
        oauth: ReturnType<typeof findOauthCredential>;
      }
    >;
    return rows.sort((a, b) =>
      compareProviderRailOrder(a.key, b.key, a.label, b.label),
    );
  }, [credentials.apiKeys, credentials.oauthCredentials]);

  const handleRemove = useCallback(
    async (providerKey: string, kind: "key" | "oauth") => {
      setRemovingProvider(providerKey);
      try {
        if (kind === "key") {
          await credentials.removeApiKey(providerKey);
        } else {
          await credentials.logoutOAuth(providerKey);
        }
      } catch {
        // Failures surface via the credentials hook's `error` state on the
        // next reload; nothing useful to do inline here.
      } finally {
        setRemovingProvider(null);
      }
    },
    [credentials],
  );

  if (connectedProviders.length === 0 && !credentials.error) return null;

  return (
    <div className="engine-tab__connected">
      <h4 className="engine-tab__section-title">
        {t("settings.connectedProviders.title")}
      </h4>
      {credentials.error ? (
        <p className="engine-tab__error" role="alert">
          {credentials.error}
        </p>
      ) : null}
      <ul className="engine-tab__connected-list">
        {connectedProviders.map((provider) => {
          const isRemoving = removingProvider === provider.key;
          return (
            <li key={provider.key} className="engine-tab__connected-row">
              <div className="engine-tab__connected-info">
                <span className="engine-tab__connected-label">
                  {provider.label}
                </span>
                <span className="engine-tab__connected-sublabel">
                  {provider.apiKey
                    ? t("settings.connectedProviders.apiKey")
                    : null}
                  {provider.apiKey && provider.oauth ? " · " : null}
                  {provider.oauth
                    ? t("settings.connectedProviders.signedIn")
                    : null}
                </span>
              </div>
              <div className="engine-tab__connected-actions">
                {provider.apiKey ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="engine-tab__connected-btn"
                    onClick={() => void handleRemove(provider.key, "key")}
                    disabled={isRemoving}
                  >
                    {isRemoving
                      ? t("settings.connectedProviders.removingKey")
                      : t("settings.connectedProviders.removeKey")}
                  </Button>
                ) : null}
                {provider.oauth ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="engine-tab__connected-btn"
                    onClick={() => void handleRemove(provider.key, "oauth")}
                    disabled={isRemoving}
                  >
                    {isRemoving
                      ? t("settings.connectedProviders.signingOut")
                      : t("settings.connectedProviders.signOut")}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Assignment popover ─────────────────────────────────────── */

interface AssignmentPopoverProps {
  assignment: {
    modelId: string;
    rect: DOMRect;
    initialReasoning: ReasoningEffort;
    initialAgents: string[];
  };
  configurableAgents: ReadonlyArray<{
    key: string;
    label: string;
    desc: string;
  }>;
  overrides: Record<string, string>;
  reasoningEfforts: Record<string, ReasoningEffort>;
  modelNamesById: ReadonlyMap<string, string>;
  pending: boolean;
  onApply: (agentKeys: string[], effort: ReasoningEffort) => void;
  onApplyToAll: (effort: ReasoningEffort) => void;
  onClose: () => void;
}

function AssignmentPopover({
  assignment,
  configurableAgents,
  overrides,
  reasoningEfforts,
  modelNamesById,
  pending,
  onApply,
  onApplyToAll,
  onClose,
}: AssignmentPopoverProps) {
  const generalAgentOnly = assignment.modelId.startsWith(CURSOR_MODEL_PREFIX);
  const [reasoning, setReasoning] = useState<ReasoningEffort>(
    assignment.initialReasoning,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => {
    const initial = new Set(assignment.initialAgents);
    if (generalAgentOnly) {
      return new Set(
        configurableAgents.some((entry) => entry.key === GENERAL_AGENT_KEY)
          ? [GENERAL_AGENT_KEY]
          : [],
      );
    }
    return initial;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>(
    () => ({
      left: Math.max(16, assignment.rect.left - 310),
      top: Math.max(16, assignment.rect.top),
    }),
  );
  const [backdropReady, setBackdropReady] = useState(false);

  const modelDisplayName =
    modelNamesById.get(assignment.modelId) ?? assignment.modelId;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const panelRect = panel.getBoundingClientRect();
    const margin = 16;
    const gap = 10;
    let left = assignment.rect.left - panelRect.width - gap;
    if (left < margin) {
      left = assignment.rect.right + gap;
    }
    left = Math.max(
      margin,
      Math.min(left, window.innerWidth - panelRect.width - margin),
    );
    let top = assignment.rect.top;
    top = Math.max(
      margin,
      Math.min(top, window.innerHeight - panelRect.height - margin),
    );
    setPosition({ left, top });
  }, [assignment.modelId, assignment.rect]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setBackdropReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggleAgent = (key: string) => {
    if (generalAgentOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return createPortal(
    <>
      <button
        type="button"
        className="engine-tab__assign-backdrop"
        aria-label="Close model assignment"
        tabIndex={-1}
        onClick={() => {
          if (backdropReady) onClose();
        }}
      />
      <div
        ref={panelRef}
        className="engine-tab__assign-popover"
        role="dialog"
        aria-modal="true"
        aria-label="Apply model to agents"
        style={{
          position: "fixed",
          left: position.left,
          top: position.top,
          zIndex: 10000,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="engine-tab__assign-head">
          <span className="engine-tab__assign-kicker">Apply</span>
          <span className="engine-tab__assign-title" title={modelDisplayName}>
            {modelDisplayName}
          </span>
        </header>

        {generalAgentOnly ? null : (
          <section
            className="engine-tab__assign-reasoning"
            role="radiogroup"
            aria-label="Reasoning effort"
          >
            {REASONING_OPTIONS.map((option) => {
              const isSelected = option.id === reasoning;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  data-selected={isSelected || undefined}
                  className="engine-tab__assign-reasoning-btn"
                  title={option.title}
                  onClick={() => setReasoning(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </section>
        )}

        <section
          className="engine-tab__assign-agents"
          role="group"
          aria-label="Agents"
        >
          {configurableAgents.map((entry) => {
            const isChecked = generalAgentOnly
              ? entry.key === GENERAL_AGENT_KEY
              : selected.has(entry.key);
            const current = overrides[entry.key];
            const sameModel = current === assignment.modelId;
            const currentEffort = reasoningEfforts[entry.key] ?? "default";
            const effortLabel =
              REASONING_OPTIONS.find((opt) => opt.id === currentEffort)
                ?.label ?? "Auto";
            const title = sameModel
              ? `Currently using this model${
                  currentEffort !== "default" ? ` · ${effortLabel}` : ""
                }`
              : current
                ? `Currently: ${modelNamesById.get(current) ?? current}${
                    currentEffort !== "default" ? ` · ${effortLabel}` : ""
                  }`
                : "Currently default";
            return (
              <button
                key={entry.key}
                type="button"
                role="checkbox"
                aria-checked={isChecked}
                className="engine-tab__assign-agent-pill"
                data-checked={isChecked || undefined}
                data-current={sameModel || undefined}
                title={title}
                onClick={() => toggleAgent(entry.key)}
                disabled={generalAgentOnly && entry.key !== GENERAL_AGENT_KEY}
              >
                {entry.label}
              </button>
            );
          })}
        </section>

        <footer className="engine-tab__assign-footer">
          {generalAgentOnly ? null : (
            <button
              type="button"
              className="engine-tab__assign-apply-all"
              disabled={pending}
              onClick={() => onApplyToAll(reasoning)}
              title="Apply this model to every configurable agent"
            >
              Apply to all
            </button>
          )}
          <div className="engine-tab__assign-footer-actions">
            <button
              type="button"
              className="engine-tab__assign-cancel"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="engine-tab__assign-apply"
              disabled={pending}
              onClick={() => onApply(Array.from(selected), reasoning)}
            >
              Apply
            </button>
          </div>
        </footer>
      </div>
    </>,
    document.body,
  );
}
