/**
 * SettingsModelsView — Settings → Models (advanced surface).
 *
 * Two-column master/detail. Left rail lists every configurable agent
 * plus the Image and Voice surfaces; right pane shows the full
 * provider/model picker for the selected entry with every provider
 * (Stella + each BYOK provider) one click away — no "more options"
 * disclosure, no curated subset. The composer's model picker stays the
 * one-click "normal" surface; this page is the everything-visible one.
 *
 * Reuses the existing read/write IPC (`getLocalModelPreferences` /
 * `setLocalModelPreferences`), `useModelCatalog`, `ProviderModelPanel`,
 * and `ProviderOnlyPicker`/`VoiceCatalogPicker`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MoreHorizontal, RefreshCw, RotateCcw } from "lucide-react";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import { ProviderOnlyPicker, type ProviderOption } from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import {
  getStellaDisplayName,
} from "@/global/settings/lib/model-catalog";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getConfigurableAgents,
  getDefaultModelOptionLabel,
  getLocalModelDefaults,
  getModelDisplayLabel,
  normalizeModelOverrides,
} from "@/global/settings/lib/model-defaults";
import { STELLA_STANDARD_MODEL } from "@/shared/stella-api";
import {
  getPlanLabel,
  isRestrictedModelOverrideAudience,
} from "@/shared/billing/audience";
import {
  coerceRealtimeVoiceProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceUnderlyingProvider,
} from "../../../../runtime/contracts/local-preferences";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import "./SettingsModelsView.css";

type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

type ImageGenerationProvider = "stella" | "openai" | "openrouter" | "fal";
type ImageGenerationPreferences = {
  provider: ImageGenerationProvider;
  model?: string;
};

type LocalModelPreferencesShape = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  assistantPropagatedAgents: string[];
  reasoningEfforts: Record<string, ReasoningEffort>;
  agentRuntimeEngine: "default" | "claude_code_local";
  maxAgentConcurrency: number;
  imageGeneration: ImageGenerationPreferences;
  realtimeVoice: RealtimeVoicePreferences;
};

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

const isStellaModelId = (modelId: string): boolean =>
  modelId === "" || modelId.startsWith("stella/");

/**
 * Last-known local preferences cached at module scope so reopening the
 * picker after a remount doesn't flash a loading row.
 */
let cachedLocalPreferences: LocalModelPreferencesShape | null = null;

function useLocalModelPreferences(): {
  preferences: LocalModelPreferencesShape | null;
  write: (
    patch: Partial<LocalModelPreferencesShape>,
  ) => Promise<LocalModelPreferencesShape | null>;
  pending: boolean;
  error: string | null;
} {
  const [preferences, setPreferencesState] =
    useState<LocalModelPreferencesShape | null>(() => cachedLocalPreferences);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setPreferences = useCallback(
    (next: LocalModelPreferencesShape | null) => {
      if (next) cachedLocalPreferences = next;
      setPreferencesState(next);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled && next) setPreferences(next as LocalModelPreferencesShape);
        if (!cancelled) setError(null);
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

  const write = useCallback(
    async (
      patch: Partial<LocalModelPreferencesShape>,
    ): Promise<LocalModelPreferencesShape | null> => {
      if (!preferences) return null;
      const previous = preferences;
      const optimistic: LocalModelPreferencesShape = {
        ...previous,
        ...patch,
      };
      setPreferences(optimistic);
      setPending(true);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        const next = (saved as LocalModelPreferencesShape | undefined) ?? optimistic;
        setPreferences(next);
        window.dispatchEvent(
          new CustomEvent("stella:local-model-preferences-changed"),
        );
        setError(null);
        return next;
      } catch (caught) {
        setPreferences(previous);
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to update model setting.",
        );
        return null;
      } finally {
        setPending(false);
      }
    },
    [preferences, setPreferences],
  );

  return { preferences, write, pending, error };
}

/* ── grouping ─────────────────────────────────────────────────── */

const CONVERSATION_AGENT_KEYS: ReadonlySet<string> = new Set([
  "orchestrator",
  "general",
]);

type AgentEntry = { key: string; label: string; desc: string };

function partitionAgents(agents: readonly AgentEntry[]): {
  conversation: AgentEntry[];
  background: AgentEntry[];
} {
  const conversation: AgentEntry[] = [];
  const background: AgentEntry[] = [];
  for (const entry of agents) {
    if (CONVERSATION_AGENT_KEYS.has(entry.key)) conversation.push(entry);
    else background.push(entry);
  }
  conversation.sort((a, b) => {
    if (a.key === b.key) return 0;
    if (a.key === "orchestrator") return -1;
    if (b.key === "orchestrator") return 1;
    return 0;
  });
  return { conversation, background };
}

/* ── list item (left rail) ────────────────────────────────────── */

interface ListItemProps {
  label: string;
  desc: string;
  valueLabel: string;
  isOverridden: boolean;
  isSelected: boolean;
  reasoningChip: string | null;
  onSelect: () => void;
}

function ListItem({
  label,
  desc,
  valueLabel,
  isOverridden,
  isSelected,
  reasoningChip,
  onSelect,
}: ListItemProps) {
  return (
    <button
      type="button"
      className="models-list-item"
      data-selected={isSelected || undefined}
      aria-pressed={isSelected}
      onClick={onSelect}
    >
      <span className="models-list-item-main">
        <span className="models-list-item-name">{label}</span>
        <span className="models-list-item-desc">{desc}</span>
      </span>
      <span className="models-list-item-value">
        <span
          className="models-list-item-value-label"
          data-overridden={isOverridden || undefined}
        >
          {valueLabel}
        </span>
        {reasoningChip ? (
          <span className="models-list-item-chip">{reasoningChip}</span>
        ) : null}
      </span>
    </button>
  );
}

/* ── view ─────────────────────────────────────────────────────── */

const IMAGE_KEY = "__image__";
const VOICE_KEY = "__voice__";

export function SettingsModelsView() {
  const {
    models: stellaModels,
    defaults: stellaDefaultModels,
    groups,
    refresh,
    refreshing,
    audience,
  } = useModelCatalog();

  const { preferences, write, pending, error } = useLocalModelPreferences();

  // Master/detail: left selection drives the right pane. Orchestrator
  // is the most common starting point.
  const [selectedKey, setSelectedKey] = useState<string>("orchestrator");

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
  const configurableAgents = useMemo(
    () => getConfigurableAgents(modelDefaults),
    [modelDefaults],
  );
  const { conversation: conversationAgents, background: backgroundAgents } =
    useMemo(() => partitionAgents(configurableAgents), [configurableAgents]);

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

  const restricted = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  /* ── mutation handlers ───────────────────────────────────────── */

  const handleSelectModel = useCallback(
    async (agentKey: string, value: string) => {
      if (!preferences) return;
      const nextOverrides = { ...preferences.modelOverrides };
      if (value === "") delete nextOverrides[agentKey];
      else nextOverrides[agentKey] = value;
      const nextPropagated = (
        preferences.assistantPropagatedAgents ?? []
      ).filter((key) => key !== agentKey);
      await write({
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: nextPropagated,
      });
    },
    [preferences, write],
  );

  const handleSelectReasoning = useCallback(
    async (agentKey: string, effort: ReasoningEffort) => {
      if (!preferences) return;
      const next = { ...(preferences.reasoningEfforts ?? {}) };
      if (effort === "default") delete next[agentKey];
      else next[agentKey] = effort;
      await write({ reasoningEfforts: next });
    },
    [preferences, write],
  );

  const handleResetAgent = useCallback(
    async (agentKey: string) => {
      if (!preferences) return;
      const nextOverrides = { ...preferences.modelOverrides };
      delete nextOverrides[agentKey];
      const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
      delete nextReasoning[agentKey];
      const nextPropagated = (
        preferences.assistantPropagatedAgents ?? []
      ).filter((key) => key !== agentKey);
      await write({
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: nextPropagated,
        reasoningEfforts: nextReasoning,
      });
    },
    [preferences, write],
  );

  const handleApplyToAll = useCallback(
    async (value: string) => {
      if (!preferences || value === "") return;
      const nextOverrides = { ...preferences.modelOverrides };
      for (const entry of configurableAgents) {
        nextOverrides[entry.key] = value;
      }
      const nextPropagated = isStellaModelId(value)
        ? []
        : configurableAgents
            .map((entry) => entry.key)
            .filter((key) => !CONVERSATION_AGENT_KEYS.has(key));
      await write({
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: nextPropagated,
      });
    },
    [preferences, configurableAgents, write],
  );

  const handleResetAll = useCallback(async () => {
    if (!preferences) return;
    await write({
      modelOverrides: {},
      assistantPropagatedAgents: [],
      reasoningEfforts: {},
    });
  }, [preferences, write]);

  /* ── global engine ───────────────────────────────────────────── */

  // Engine is a process-wide choice (Stella's own runner vs the local
  // Claude Code CLI) — not per-agent. Lives next to the title rather
  // than buried in each agent's detail pane.
  const engine: "default" | "claude_code_local" =
    preferences?.agentRuntimeEngine ?? "default";
  const handleEngineChange = useCallback(
    async (next: "default" | "claude_code_local") => {
      if (!preferences || preferences.agentRuntimeEngine === next) return;
      await write({ agentRuntimeEngine: next });
    },
    [preferences, write],
  );
  const ENGINE_OPTIONS: ReadonlyArray<{
    id: "default" | "claude_code_local";
    label: string;
  }> = [
    { id: "default", label: "Stella" },
    { id: "claude_code_local", label: "Claude Code" },
  ];

  /* ── image / voice handlers ──────────────────────────────────── */

  const imagePreferences =
    preferences?.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
  const voicePreferences = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;

  const handleImageProviderSelect = useCallback(
    async (providerKey: string) => {
      const next: ImageGenerationPreferences =
        providerKey === "openai"
          ? { provider: "openai" }
          : providerKey === "openrouter"
            ? { provider: "openrouter" }
            : providerKey === "fal"
              ? { provider: "fal" }
              : { provider: "stella" };
      await write({ imageGeneration: next });
    },
    [write],
  );

  const handleVoiceProviderSelect = useCallback(
    async (providerKey: string) => {
      const previous =
        preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
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
      await write({ realtimeVoice: next });
    },
    [preferences, write],
  );

  const handleVoiceSelect = useCallback(
    async (
      underlyingProvider: RealtimeVoiceUnderlyingProvider,
      voiceId: string,
    ) => {
      const previous =
        preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      await write({
        realtimeVoice: {
          ...previous,
          voices: {
            ...(previous.voices ?? {}),
            [underlyingProvider]: voiceId,
          },
        },
      });
    },
    [preferences, write],
  );

  const handleVoiceSubProviderSelect = useCallback(
    async (sub: RealtimeVoiceUnderlyingProvider) => {
      const previous =
        preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      if (previous.stellaSubProvider === sub) return;
      await write({
        realtimeVoice: { ...previous, stellaSubProvider: sub },
      });
    },
    [preferences, write],
  );

  const handleInworldSpeedSelect = useCallback(
    async (speed: number) => {
      const previous =
        preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
      const clamped = Math.min(2.0, Math.max(0.5, speed));
      if (
        typeof previous.inworldSpeed === "number" &&
        Math.abs(previous.inworldSpeed - clamped) < 0.001
      ) {
        return;
      }
      await write({
        realtimeVoice: { ...previous, inworldSpeed: clamped },
      });
    },
    [preferences, write],
  );

  /* ── row value helpers ───────────────────────────────────────── */

  const agentListValue = (
    entry: AgentEntry,
  ): {
    valueLabel: string;
    isOverridden: boolean;
    reasoningChip: string | null;
  } => {
    const currentValue = overrides[entry.key] ?? "";
    const isOverridden = Boolean(currentValue);
    const valueLabel = currentValue
      ? getModelDisplayLabel(currentValue, modelNamesById)
      : modelNamesById.get(
          resolvedDefaultModelMap[entry.key] ??
            defaultModelMap[entry.key] ??
            STELLA_STANDARD_MODEL,
        ) ?? "Stella";
    const reasoning = preferences?.reasoningEfforts?.[entry.key] ?? "default";
    const reasoningOpt = REASONING_OPTIONS.find((opt) => opt.id === reasoning);
    const reasoningChip =
      reasoning !== "default" && reasoningOpt ? reasoningOpt.label : null;
    return { valueLabel, isOverridden, reasoningChip };
  };

  const orchestratorCurrent =
    overrides.orchestrator ?? overrides.general ?? "";

  /* ── left rail renderers ─────────────────────────────────────── */

  const renderAgentItem = (entry: AgentEntry): ReactNode => {
    const v = agentListValue(entry);
    return (
      <ListItem
        key={entry.key}
        label={entry.label}
        desc={entry.desc}
        valueLabel={v.valueLabel}
        isOverridden={v.isOverridden}
        reasoningChip={v.reasoningChip}
        isSelected={selectedKey === entry.key}
        onSelect={() => setSelectedKey(entry.key)}
      />
    );
  };

  /* ── right pane content for the active selection ─────────────── */

  const renderDetail = (): ReactNode => {
    if (selectedKey === IMAGE_KEY) {
      const provider = imagePreferences.provider ?? "stella";
      return (
        <div className="models-detail">
          <div className="models-detail-head">
            <div className="models-detail-head-text">
              <span className="models-detail-head-title">Image</span>
              <span className="models-detail-head-desc">
                Photo and image-edit generation provider
              </span>
            </div>
          </div>
          <div className="models-detail-body">
            <ProviderOnlyPicker
              providers={IMAGE_PROVIDER_OPTIONS}
              value={provider}
              onSelect={(key) => void handleImageProviderSelect(key)}
              disabled={pending}
              ariaLabel="Image provider"
            />
          </div>
        </div>
      );
    }
    if (selectedKey === VOICE_KEY) {
      const provider = voicePreferences.provider ?? "stella";
      return (
        <div className="models-detail">
          <div className="models-detail-head">
            <div className="models-detail-head-text">
              <span className="models-detail-head-title">Voice</span>
              <span className="models-detail-head-desc">
                Realtime voice provider and voice selection
              </span>
            </div>
          </div>
          <div className="models-detail-body">
            <ProviderOnlyPicker
              providers={VOICE_PROVIDER_OPTIONS}
              value={provider}
              onSelect={(key) => void handleVoiceProviderSelect(key)}
              disabled={pending}
              ariaLabel="Voice provider"
            />
            <VoiceCatalogPicker
              voiceProvider={voicePreferences.provider}
              stellaSubProvider={voicePreferences.stellaSubProvider}
              selectedVoices={voicePreferences.voices}
              inworldSpeed={voicePreferences.inworldSpeed}
              onSelectVoice={(underlying, voiceId) =>
                void handleVoiceSelect(underlying, voiceId)
              }
              onSelectStellaSubProvider={(sub) =>
                void handleVoiceSubProviderSelect(sub)
              }
              onSelectInworldSpeed={(speed) =>
                void handleInworldSpeedSelect(speed)
              }
              disabled={pending}
            />
          </div>
        </div>
      );
    }

    // Agent detail — full provider/model picker with Stella + every
    // BYOK provider as siblings (no disclosure), reasoning segmented
    // control beneath, footer with Reset / Apply-to-all.
    const entry =
      configurableAgents.find((e) => e.key === selectedKey) ??
      configurableAgents[0];
    if (!entry) {
      return <div className="models-detail models-detail--empty">Loading…</div>;
    }
    const currentValue = overrides[entry.key] ?? "";
    const defaultModel = defaultModelMap[entry.key] ?? STELLA_STANDARD_MODEL;
    const isOverridden =
      Boolean(currentValue) && currentValue !== defaultModel;
    const defaultLabel = preferences
      ? getDefaultModelOptionLabel(
          entry.key,
          defaultModelMap,
          resolvedDefaultModelMap,
          modelNamesById,
        )
      : "Default";
    const currentLabel = currentValue ? currentValue : defaultLabel;
    const reasoning =
      preferences?.reasoningEfforts?.[entry.key] ?? "default";

    return (
      <div className="models-detail">
        <div className="models-detail-head">
          <div className="models-detail-head-text">
            <span className="models-detail-head-title">{entry.label}</span>
            <span className="models-detail-head-desc">{entry.desc}</span>
          </div>
          {isOverridden ? (
            <button
              type="button"
              className="models-detail-reset"
              onClick={() => void handleResetAgent(entry.key)}
              disabled={pending}
              title="Use the default for this agent"
            >
              Reset to default
            </button>
          ) : null}
        </div>

        <div className="models-detail-body">
          <ProviderModelPanel
            // Key on the agent id so internal tab + search state reset
            // cleanly when the user switches agents.
            key={entry.key}
            value={currentValue}
            defaultLabel={defaultLabel}
            currentLabel={currentLabel}
            groups={groups}
            excludeModelId={defaultModel}
            disabled={pending}
            restrictStellaPicks={restricted}
            restrictedPlanLabel={restrictedPlanLabel}
            ariaLabel={`${entry.label} model picker`}
            onSelect={(value) => void handleSelectModel(entry.key, value)}
          />
        </div>

        <div className="models-detail-footer">
          <div className="models-detail-reasoning">
            <span className="models-detail-reasoning-label">Reasoning</span>
            <div
              className="models-detail-reasoning-segment"
              role="radiogroup"
              aria-label="Reasoning effort"
            >
              {REASONING_OPTIONS.map((option) => {
                const selected = option.id === reasoning;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-selected={selected || undefined}
                    className="models-detail-reasoning-btn"
                    disabled={pending}
                    title={option.title}
                    onClick={() =>
                      void handleSelectReasoning(entry.key, option.id)
                    }
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          {currentValue ? (
            <button
              type="button"
              className="models-detail-apply-all"
              disabled={pending}
              onClick={() => void handleApplyToAll(currentValue)}
              title="Apply this model to every configurable agent"
            >
              Apply to all agents
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="models-editor">
      <header className="models-editor-header">
        <div className="models-editor-title">
          <h2>Models</h2>
          <p>
            Every agent, every provider. Pick the agent on the left, pick the
            model on the right.
          </p>
        </div>
        <div className="models-editor-header-actions">
          <div className="models-editor-engine" role="radiogroup" aria-label="Agent engine">
            <span className="models-editor-engine-label">Engine</span>
            <div className="models-editor-engine-segment">
              {ENGINE_OPTIONS.map((option) => {
                const selected = option.id === engine;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-selected={selected || undefined}
                    className="models-editor-engine-btn"
                    disabled={pending || !preferences}
                    onClick={() => void handleEngineChange(option.id)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="models-editor-kebab"
              title="More"
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
              disabled={!orchestratorCurrent || pending}
              onSelect={() => void handleApplyToAll(orchestratorCurrent)}
            >
              Apply orchestrator's model to all
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
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
      </header>

      {error ? (
        <p className="models-editor-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="models-editor-split">
        <aside
          className="models-editor-rail"
          role="tablist"
          aria-label="Agents and media"
          aria-orientation="vertical"
        >
          <section className="models-editor-section">
            <div className="models-editor-section-label">Conversation</div>
            <div className="models-editor-list">
              {conversationAgents.length === 0 ? (
                <ListItemSkeleton />
              ) : (
                conversationAgents.map(renderAgentItem)
              )}
            </div>
          </section>

          <section className="models-editor-section">
            <div className="models-editor-section-label">Media</div>
            <div className="models-editor-list">
              <ListItem
                label="Image"
                desc="Photo and image-edit provider"
                valueLabel={
                  IMAGE_PROVIDER_OPTIONS.find(
                    (opt) =>
                      opt.key === (imagePreferences.provider ?? "stella"),
                  )?.label ?? "Stella"
                }
                isOverridden={
                  (imagePreferences.provider ?? "stella") !== "stella"
                }
                reasoningChip={null}
                isSelected={selectedKey === IMAGE_KEY}
                onSelect={() => setSelectedKey(IMAGE_KEY)}
              />
              <ListItem
                label="Voice"
                desc="Realtime voice provider"
                valueLabel={
                  VOICE_PROVIDER_OPTIONS.find(
                    (opt) =>
                      opt.key === (voicePreferences.provider ?? "stella"),
                  )?.label ?? "Stella"
                }
                isOverridden={
                  (voicePreferences.provider ?? "stella") !== "stella"
                }
                reasoningChip={null}
                isSelected={selectedKey === VOICE_KEY}
                onSelect={() => setSelectedKey(VOICE_KEY)}
              />
            </div>
          </section>

          {backgroundAgents.length > 0 ? (
            <section className="models-editor-section">
              <div className="models-editor-section-label">Background</div>
              <div className="models-editor-list">
                {backgroundAgents.map(renderAgentItem)}
              </div>
            </section>
          ) : null}
        </aside>

        <div className="models-editor-pane" role="tabpanel">
          {renderDetail()}
        </div>
      </div>
    </div>
  );
}

function ListItemSkeleton() {
  return (
    <div
      className="models-list-item models-list-item--skeleton"
      aria-hidden="true"
    >
      <span className="models-list-item-main">
        <span className="models-list-item-name">Loading…</span>
      </span>
    </div>
  );
}
