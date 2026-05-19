/**
 * SettingsModelsView — the redesigned Settings → Models surface.
 *
 * Replaces the tabbed `AgentModelPicker surface="settings"` layout with
 * a file-editor-style list: every configurable agent is a row showing
 * its current model + reasoning effort. Clicking the row opens an
 * anchored popover with the actual chooser (Stella presets + BYOK
 * expansion, plus a reasoning effort strip), and bulk actions live in
 * a single top-right menu.
 *
 * Reuses the existing read/write IPC (`getLocalModelPreferences` /
 * `setLocalModelPreferences`), `useModelCatalog`, and the catalog's
 * `CompactStellaModelList` / `ProviderModelPanel` so this is purely a
 * layout/UX redesign — the underlying preference shape is unchanged.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { CompactStellaModelList } from "@/global/settings/CompactStellaModelList";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import { ProviderOnlyPicker, type ProviderOption } from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import { LocalRuntimeOptions } from "@/global/settings/LocalRuntimeOptions";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import {
  getStellaDisplayName,
  type CatalogModel,
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
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import {
  getPlanLabel,
  isRestrictedModelOverrideAudience,
} from "@/shared/billing/audience";
import {
  coerceRealtimeVoiceProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceUnderlyingProvider,
} from "../../../../runtime/contracts/local-preferences";
import { router } from "@/router";
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

/**
 * Hook that loads `LocalModelPreferences` and syncs with the existing
 * `stella:local-model-preferences-changed` event so an edit anywhere
 * (composer submenu, this view, etc.) re-renders every other reader.
 */
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

const ASSISTANT_AGENT_KEYS: ReadonlySet<string> = new Set([
  "orchestrator",
  "general",
]);

type AgentEntry = { key: string; label: string; desc: string };

function groupAgents(agents: readonly AgentEntry[]): {
  assistant: AgentEntry[];
  background: AgentEntry[];
} {
  const assistant: AgentEntry[] = [];
  const background: AgentEntry[] = [];
  for (const entry of agents) {
    if (ASSISTANT_AGENT_KEYS.has(entry.key)) assistant.push(entry);
    else background.push(entry);
  }
  // Keep orchestrator above general within Assistant; preserve the
  // catalog-supplied order for everything else.
  assistant.sort((a, b) => {
    if (a.key === b.key) return 0;
    if (a.key === "orchestrator") return -1;
    if (b.key === "orchestrator") return 1;
    return 0;
  });
  return { assistant, background };
}

/* ── chooser body shared by agent rows ────────────────────────── */

interface AgentChooserProps {
  agentLabel: string;
  agentDesc: string;
  currentValue: string;
  defaultLabel: string;
  pending: boolean;
  restricted: boolean;
  restrictedPlanLabel: string | null;
  reasoning: ReasoningEffort;
  stellaModels: readonly CatalogModel[];
  groups: ReturnType<typeof useModelCatalog>["groups"];
  onSelectModel: (value: string) => void;
  onSelectReasoning: (effort: ReasoningEffort) => void;
  onApplyToAll: (value: string) => void;
  onReset: () => void;
}

function AgentChooser({
  agentLabel,
  agentDesc,
  currentValue,
  defaultLabel,
  pending,
  restricted,
  restrictedPlanLabel,
  reasoning,
  stellaModels,
  groups,
  onSelectModel,
  onSelectReasoning,
  onApplyToAll,
  onReset,
}: AgentChooserProps) {
  const [expanded, setExpanded] = useState(false);
  const isOverridden =
    Boolean(currentValue) && currentValue !== STELLA_DEFAULT_MODEL;
  const currentLabel = currentValue ? currentValue : defaultLabel;

  return (
    <div className="models-chooser">
      <div className="models-chooser__head">
        <div className="models-chooser__head-text">
          <span className="models-chooser__head-label">{agentLabel}</span>
          <span className="models-chooser__head-desc">{agentDesc}</span>
        </div>
        {isOverridden ? (
          <button
            type="button"
            className="models-chooser__head-reset"
            onClick={onReset}
            disabled={pending}
            title="Use the default for this agent"
          >
            <RotateCcw size={11} strokeWidth={2} />
            Reset
          </button>
        ) : null}
      </div>

      <div className="models-chooser__body">
        {expanded ? (
          <>
            <ProviderModelPanel
              value={currentValue}
              defaultLabel={defaultLabel}
              currentLabel={currentLabel}
              groups={groups}
              excludeModelId={STELLA_DEFAULT_MODEL}
              disabled={pending}
              restrictStellaPicks={restricted}
              restrictedPlanLabel={restrictedPlanLabel}
              ariaLabel="Model picker"
              onSelect={onSelectModel}
            />
            <LocalRuntimeOptions />
          </>
        ) : (
          <CompactStellaModelList
            stellaModels={stellaModels}
            value={currentValue}
            defaultLabel={defaultLabel}
            onSelect={onSelectModel}
            disabled={pending}
            restricted={restricted}
            restrictedPlanLabel={restrictedPlanLabel}
            onUpgrade={() => {
              void router.navigate({ to: "/billing" });
            }}
          />
        )}
      </div>

      <div className="models-chooser__reasoning">
        <span className="models-chooser__reasoning-label">Reasoning</span>
        <div
          className="models-chooser__reasoning-segment"
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
                className="models-chooser__reasoning-btn"
                disabled={pending}
                title={option.title}
                onClick={() => onSelectReasoning(option.id)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="models-chooser__footer">
        <button
          type="button"
          className="models-chooser__more"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          <span>
            {expanded ? "Hide providers" : "Connect a provider (BYOK)"}
          </span>
          <ChevronDown
            size={12}
            strokeWidth={2}
            data-rotated={expanded || undefined}
          />
        </button>
        {currentValue ? (
          <button
            type="button"
            className="models-chooser__apply-all"
            disabled={pending}
            onClick={() => onApplyToAll(currentValue)}
            title="Apply this model to every configurable agent"
          >
            Use for all agents
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ── list row ─────────────────────────────────────────────────── */

interface ListRowProps {
  label: string;
  desc: string;
  badgePrimary: string;
  badgeSub?: string | null;
  reasoningChipLabel?: string | null;
  reasoningChipTitle?: string | null;
  isOverridden: boolean;
  isSelected: boolean;
  onSelect: () => void;
}

function ListRow({
  label,
  desc,
  badgePrimary,
  badgeSub,
  reasoningChipLabel,
  reasoningChipTitle,
  isOverridden,
  isSelected,
  onSelect,
}: ListRowProps) {
  return (
    <button
      type="button"
      className="models-row"
      data-selected={isSelected || undefined}
      data-overridden={isOverridden || undefined}
      aria-pressed={isSelected}
      onClick={onSelect}
    >
      <span className="models-row__main">
        <span className="models-row__name">{label}</span>
        <span className="models-row__desc">{desc}</span>
      </span>
      <span className="models-row__value">
        <span className="models-row__value-label">
          <span className="models-row__value-primary">{badgePrimary}</span>
          {badgeSub ? (
            <span className="models-row__value-sub">{badgeSub}</span>
          ) : null}
        </span>
        {reasoningChipLabel ? (
          <span
            className="models-row__chip"
            title={reasoningChipTitle ?? undefined}
          >
            {reasoningChipLabel}
          </span>
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

  // Master/detail: orchestrator selected by default; flips to the row
  // the user clicks. Image / voice use the same selection state via
  // their `__image__` / `__voice__` sentinel keys.
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
  const { assistant: assistantAgents, background: backgroundAgents } = useMemo(
    () => groupAgents(configurableAgents),
    [configurableAgents],
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

  const restricted = isRestrictedModelOverrideAudience(audience);
  const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;

  const handleSelectModel = useCallback(
    async (agentKey: string, value: string) => {
      if (!preferences) return;
      const nextOverrides = { ...preferences.modelOverrides };
      if (value === "") delete nextOverrides[agentKey];
      else nextOverrides[agentKey] = value;
      // Picking a model explicitly for a single agent means the user is
      // taking ownership — remove it from `assistantPropagatedAgents`
      // so a later Assistant-side switch doesn't wipe their pick.
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
      // BYOK pick → mark every other agent as propagated so a later
      // assistant-side switch can clean it back up. Stella picks
      // intentionally leave the propagated set empty.
      const nextPropagated = isStellaModelId(value)
        ? []
        : configurableAgents
            .map((entry) => entry.key)
            .filter((key) => !ASSISTANT_AGENT_KEYS.has(key));
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

  /* ── row badge helpers ───────────────────────────────────────── */

  const agentBadge = (
    entry: AgentEntry,
  ): {
    badgePrimary: string;
    badgeSub: string | null;
    reasoningChip: { label: string; title: string } | null;
    isOverridden: boolean;
  } => {
    const currentValue = overrides[entry.key] ?? "";
    const isOverridden = Boolean(currentValue);
    const badgePrimary = currentValue
      ? getModelDisplayLabel(currentValue, modelNamesById)
      : modelNamesById.get(
          resolvedDefaultModelMap[entry.key] ??
            defaultModelMap[entry.key] ??
            STELLA_DEFAULT_MODEL,
        ) ?? "Stella";
    const badgeSub = currentValue ? null : "Default";
    const reasoning =
      preferences?.reasoningEfforts?.[entry.key] ?? "default";
    const reasoningOpt = REASONING_OPTIONS.find((opt) => opt.id === reasoning);
    const reasoningChip =
      reasoning !== "default" && reasoningOpt
        ? { label: reasoningOpt.label, title: `Reasoning: ${reasoningOpt.title}` }
        : null;
    return { badgePrimary, badgeSub, reasoningChip, isOverridden };
  };

  /* ── detail panel for the currently-selected row ─────────────── */

  const renderDetail = (): ReactNode => {
    if (selectedKey === IMAGE_KEY) {
      const provider = imagePreferences.provider ?? "stella";
      return (
        <div className="models-chooser">
          <div className="models-chooser__head">
            <div className="models-chooser__head-text">
              <span className="models-chooser__head-label">Image</span>
              <span className="models-chooser__head-desc">
                Photo and image-edit generation provider
              </span>
            </div>
          </div>
          <div className="models-chooser__body">
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
        <div className="models-chooser">
          <div className="models-chooser__head">
            <div className="models-chooser__head-text">
              <span className="models-chooser__head-label">Voice</span>
              <span className="models-chooser__head-desc">
                Realtime voice provider and voice selection
              </span>
            </div>
          </div>
          <div className="models-chooser__body">
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
    // Agent detail. Resolve the selected entry; fall back to the first
    // configurable agent if the prior selection was wiped (catalog
    // reload, etc).
    const entry =
      configurableAgents.find((e) => e.key === selectedKey) ??
      configurableAgents[0];
    if (!entry) {
      return (
        <div className="models-chooser models-chooser--placeholder">
          Loading…
        </div>
      );
    }
    const currentValue = overrides[entry.key] ?? "";
    const defaultLabel = preferences
      ? getDefaultModelOptionLabel(
          entry.key,
          defaultModelMap,
          resolvedDefaultModelMap,
          modelNamesById,
        )
      : "Default";
    const reasoning =
      preferences?.reasoningEfforts?.[entry.key] ?? "default";
    return (
      <AgentChooser
        // Reset BYOK-expansion + scroll position when the user switches
        // rows by keying the chooser on the agent id.
        key={entry.key}
        agentLabel={entry.label}
        agentDesc={entry.desc}
        currentValue={currentValue}
        defaultLabel={defaultLabel}
        pending={pending}
        restricted={restricted}
        restrictedPlanLabel={restrictedPlanLabel}
        reasoning={reasoning}
        stellaModels={stellaModels}
        groups={groups}
        onSelectModel={(value) => void handleSelectModel(entry.key, value)}
        onSelectReasoning={(effort) =>
          void handleSelectReasoning(entry.key, effort)
        }
        onApplyToAll={(value) => void handleApplyToAll(value)}
        onReset={() => void handleResetAgent(entry.key)}
      />
    );
  };

  /* ── bulk actions ────────────────────────────────────────────── */

  const orchestratorCurrent =
    overrides.orchestrator ?? overrides.general ?? "";

  const renderAgentList = (entries: readonly AgentEntry[]): ReactNode => {
    if (entries.length === 0) return <RowSkeleton />;
    return entries.map((entry) => {
      const badge = agentBadge(entry);
      return (
        <ListRow
          key={entry.key}
          label={entry.label}
          desc={entry.desc}
          badgePrimary={badge.badgePrimary}
          badgeSub={badge.badgeSub}
          reasoningChipLabel={badge.reasoningChip?.label ?? null}
          reasoningChipTitle={badge.reasoningChip?.title ?? null}
          isOverridden={badge.isOverridden}
          isSelected={selectedKey === entry.key}
          onSelect={() => setSelectedKey(entry.key)}
        />
      );
    });
  };

  return (
    <div className="models-editor">
      <header className="models-editor__header">
        <div className="models-editor__title">
          <h2>Models</h2>
          <p>Pick the model behind every Stella task.</p>
        </div>
        <div className="models-editor__toolbar">
          <button
            type="button"
            className="models-editor__icon-btn"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Refresh model catalog"
            aria-label="Refresh model catalog"
          >
            <RefreshCw
              size={14}
              strokeWidth={1.75}
              data-spinning={refreshing || undefined}
            />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="models-editor__icon-btn"
                title="Bulk actions"
                aria-label="Bulk actions"
              >
                <MoreHorizontal size={14} strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" sideOffset={6}>
              <DropdownMenuItem
                disabled={!orchestratorCurrent || pending}
                onSelect={() => void handleApplyToAll(orchestratorCurrent)}
              >
                <span data-slot="dropdown-menu-item-icon">
                  <Check size={14} strokeWidth={1.75} />
                </span>
                Apply orchestrator's model to all
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
        <p className="models-editor__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="models-editor__split">
        <div
          className="models-editor__list"
          role="tablist"
          aria-label="Agents and media"
          aria-orientation="vertical"
        >
          <section className="models-editor__group">
            <h3 className="models-editor__group-label">Assistant</h3>
            <div className="models-editor__rows">
              {renderAgentList(assistantAgents)}
              <ListRow
                label="Image"
                desc="Photo and image-edit generation provider"
                badgePrimary={
                  IMAGE_PROVIDER_OPTIONS.find(
                    (opt) => opt.key === (imagePreferences.provider ?? "stella"),
                  )?.label ?? "Stella"
                }
                badgeSub={null}
                isOverridden={(imagePreferences.provider ?? "stella") !== "stella"}
                isSelected={selectedKey === IMAGE_KEY}
                onSelect={() => setSelectedKey(IMAGE_KEY)}
              />
              <ListRow
                label="Voice"
                desc="Realtime voice provider and voice selection"
                badgePrimary={
                  VOICE_PROVIDER_OPTIONS.find(
                    (opt) => opt.key === (voicePreferences.provider ?? "stella"),
                  )?.label ?? "Stella"
                }
                badgeSub={null}
                isOverridden={(voicePreferences.provider ?? "stella") !== "stella"}
                isSelected={selectedKey === VOICE_KEY}
                onSelect={() => setSelectedKey(VOICE_KEY)}
              />
            </div>
          </section>

          <section className="models-editor__group">
            <h3 className="models-editor__group-label">Background</h3>
            <div className="models-editor__rows">
              {renderAgentList(backgroundAgents)}
            </div>
          </section>
        </div>

        <div
          className="models-editor__detail"
          role="tabpanel"
          aria-label="Selected agent settings"
        >
          {renderDetail()}
        </div>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="models-row models-row--skeleton" aria-hidden="true">
      <span className="models-row__main">
        <span className="models-row__name">Loading…</span>
      </span>
    </div>
  );
}
