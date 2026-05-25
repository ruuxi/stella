/**
 * SettingsModelsView — Settings → Models (advanced surface).
 *
 * Top-level switch picks the media surface (Agents / Image / Voice).
 * On the Agents tab the full provider/model picker mounts directly:
 * providers on the left, models on the right, every BYOK provider one
 * click away — no per-agent left rail. Clicking a model opens a small
 * popover that picks the reasoning level and the target agents (or
 * "apply to all"). Storage stays unchanged: `(agent → modelId)` in
 * `modelOverrides` and `(agent → effort)` in `reasoningEfforts`. The
 * popover surfaces that two-dimension reality directly so the same
 * model paired with Low reasoning on one agent and Medium on another
 * reads as two distinct picks.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, MoreHorizontal, RefreshCw, RotateCcw } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import { ProviderOnlyPicker, type ProviderOption } from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { getStellaDisplayName } from "@/global/settings/lib/model-catalog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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

const CONVERSATION_AGENT_KEYS: ReadonlySet<string> = new Set([
  "orchestrator",
  "general",
]);

type MediaTab = "agents" | "image" | "voice";

const MEDIA_TABS: ReadonlyArray<{ id: MediaTab; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "image", label: "Image" },
  { id: "voice", label: "Voice" },
];

const ENGINE_OPTIONS: ReadonlyArray<{
  id: "default" | "claude_code_local";
  label: string;
}> = [
  { id: "default", label: "Stella" },
  { id: "claude_code_local", label: "Claude Code" },
];

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

/* ── view ─────────────────────────────────────────────────────── */

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

  const [mediaTab, setMediaTab] = useState<MediaTab>("agents");

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

  /* ── assignment popover state ────────────────────────────────── */

  type AssignmentState = {
    modelId: string;
    rect: DOMRect;
    initialReasoning: ReasoningEffort;
    initialAgents: string[];
  };
  const [assignment, setAssignment] = useState<AssignmentState | null>(null);
  const pendingRectRef = useRef<DOMRect | null>(null);

  const closeAssignment = useCallback(() => {
    setAssignment(null);
    pendingRectRef.current = null;
  }, []);

  // Bucket existing assignments by modelId so opening the popover can
  // pre-populate the agent checkboxes and reasoning chip with whatever
  // the user already has set (so re-opening reads as "edit this" rather
  // than starting from zero).
  const agentsByModel = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of configurableAgents) {
      const current = overrides[entry.key];
      if (!current) continue;
      const list = map.get(current);
      if (list) list.push(entry.key);
      else map.set(current, [entry.key]);
    }
    return map;
  }, [configurableAgents, overrides]);

  const handleModelPanelClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement | null)?.closest(
        ".model-picker-model",
      );
      if (target instanceof HTMLElement) {
        pendingRectRef.current = target.getBoundingClientRect();
      } else {
        pendingRectRef.current = null;
      }
    },
    [],
  );

  const handleOpenAssignment = useCallback(
    (modelId: string) => {
      if (!modelId) return;
      const rect = pendingRectRef.current;
      if (!rect) return;
      const initialAgents = agentsByModel.get(modelId) ?? [];
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
      setAssignment({
        modelId,
        rect,
        initialReasoning,
        initialAgents,
      });
    },
    [agentsByModel, preferences],
  );

  /* ── mutation handlers ───────────────────────────────────────── */

  const handleAssignTo = useCallback(
    async (modelId: string, agentKeys: string[], effort: ReasoningEffort) => {
      if (!preferences || agentKeys.length === 0) return;
      const nextOverrides = { ...preferences.modelOverrides };
      const nextReasoning = { ...(preferences.reasoningEfforts ?? {}) };
      const nextPropagated = new Set(
        preferences.assistantPropagatedAgents ?? [],
      );
      const nonStella = !isStellaModelId(modelId);
      for (const key of agentKeys) {
        nextOverrides[key] = modelId;
        if (effort === "default") delete nextReasoning[key];
        else nextReasoning[key] = effort;
        if (nonStella && !CONVERSATION_AGENT_KEYS.has(key)) {
          nextPropagated.add(key);
        } else {
          nextPropagated.delete(key);
        }
      }
      await write({
        modelOverrides: nextOverrides,
        reasoningEfforts: nextReasoning,
        assistantPropagatedAgents: Array.from(nextPropagated),
      });
    },
    [preferences, write],
  );

  const handleClearAgents = useCallback(
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
      await write({
        modelOverrides: nextOverrides,
        reasoningEfforts: nextReasoning,
        assistantPropagatedAgents: nextPropagated,
      });
    },
    [preferences, write],
  );

  const handleApplyAssignment = useCallback(
    async (modelId: string, agentKeys: string[], effort: ReasoningEffort) => {
      if (!preferences) {
        closeAssignment();
        return;
      }
      const previouslyAssigned = agentsByModel.get(modelId) ?? [];
      const toAssign = agentKeys;
      const toClear = previouslyAssigned.filter(
        (key) => !toAssign.includes(key),
      );
      if (toClear.length > 0) {
        await handleClearAgents(toClear);
      }
      if (toAssign.length > 0) {
        await handleAssignTo(modelId, toAssign, effort);
      }
      closeAssignment();
    },
    [
      agentsByModel,
      closeAssignment,
      handleAssignTo,
      handleClearAgents,
      preferences,
    ],
  );

  const handleApplyToAllAgents = useCallback(
    async (modelId: string, effort: ReasoningEffort) => {
      if (!preferences) {
        closeAssignment();
        return;
      }
      const allKeys = configurableAgents.map((entry) => entry.key);
      await handleAssignTo(modelId, allKeys, effort);
      closeAssignment();
    },
    [closeAssignment, configurableAgents, handleAssignTo, preferences],
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

  const engine: "default" | "claude_code_local" =
    preferences?.agentRuntimeEngine ?? "default";
  const engineLabel =
    ENGINE_OPTIONS.find((opt) => opt.id === engine)?.label ?? "Stella";
  const handleEngineChange = useCallback(
    async (next: "default" | "claude_code_local") => {
      if (!preferences || preferences.agentRuntimeEngine === next) return;
      await write({ agentRuntimeEngine: next });
    },
    [preferences, write],
  );

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

  /* ── render helpers ──────────────────────────────────────────── */

  const orchestratorCurrent =
    overrides.orchestrator ?? overrides.general ?? "";

  const renderAgentsTab = (): ReactNode => {
    const loading = configurableAgents.length === 0;
    if (loading && !preferences) {
      return <div className="models-detail--empty">Loading…</div>;
    }
    return (
      <div
        className="models-agents-pane"
        onClickCapture={handleModelPanelClickCapture}
      >
        <ProviderModelPanel
          value=""
          defaultLabel=""
          currentLabel="Click a model to assign"
          groups={groups}
          disabled={pending}
          restrictStellaPicks={restricted}
          restrictedPlanLabel={restrictedPlanLabel}
          ariaLabel="Provider and model picker"
          hideDefaultRow
          selectedHeaderKicker="Tap a model"
          hideSelectedTitle
          onSelect={(modelId) => handleOpenAssignment(modelId)}
        />
      </div>
    );
  };

  const renderImageTab = (): ReactNode => {
    const provider = imagePreferences.provider ?? "stella";
    return (
      <div className="models-detail">
        <ProviderOnlyPicker
          providers={IMAGE_PROVIDER_OPTIONS}
          value={provider}
          onSelect={(key) => void handleImageProviderSelect(key)}
          disabled={pending}
          ariaLabel="Image provider"
        />
      </div>
    );
  };

  const renderVoiceTab = (): ReactNode => {
    const provider = voicePreferences.provider ?? "stella";
    return (
      <div className="models-detail">
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
    );
  };

  const renderTabContent = (): ReactNode => {
    switch (mediaTab) {
      case "agents":
        return renderAgentsTab();
      case "image":
        return renderImageTab();
      case "voice":
        return renderVoiceTab();
    }
  };

  return (
    <div className="models-editor">
      <header className="models-editor-header">
        <div className="models-editor-title">
          <h2>Models</h2>
        </div>
        <div className="models-editor-header-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="models-editor-engine-pill"
                title="Agent engine"
                aria-label="Agent engine"
                disabled={!preferences}
              >
                <span className="models-editor-engine-pill-kicker">Engine</span>
                <span className="models-editor-engine-pill-value">
                  {engineLabel}
                </span>
                <ChevronDown
                  size={13}
                  strokeWidth={1.75}
                  aria-hidden
                  className="models-editor-engine-pill-chev"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" sideOffset={6}>
              <DropdownMenuRadioGroup
                value={engine}
                onValueChange={(next) =>
                  void handleEngineChange(
                    (next as "default" | "claude_code_local") ?? "default",
                  )
                }
              >
                {ENGINE_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.id} value={option.id}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

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
                onSelect={() =>
                  void handleAssignTo(
                    orchestratorCurrent,
                    configurableAgents.map((entry) => entry.key),
                    preferences?.reasoningEfforts?.orchestrator ?? "default",
                  )
                }
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

      <nav className="models-editor-tabs" role="tablist" aria-label="Media kind">
        {MEDIA_TABS.map((tab) => {
          const selected = tab.id === mediaTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-selected={selected || undefined}
              className="models-editor-tab"
              onClick={() => setMediaTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="models-editor-pane" role="tabpanel">
        {renderTabContent()}
      </div>

      {assignment ? (
        <AssignmentPopover
          assignment={assignment}
          configurableAgents={configurableAgents}
          overrides={overrides}
          reasoningEfforts={preferences?.reasoningEfforts ?? {}}
          modelNamesById={modelNamesById}
          pending={pending}
          onApply={(agents, effort) =>
            void handleApplyAssignment(assignment.modelId, agents, effort)
          }
          onApplyToAll={(effort) =>
            void handleApplyToAllAgents(assignment.modelId, effort)
          }
          onClose={closeAssignment}
        />
      ) : null}
    </div>
  );
}

/* ── assignment popover ──────────────────────────────────────── */

interface AssignmentPopoverProps {
  assignment: {
    modelId: string;
    rect: DOMRect;
    initialReasoning: ReasoningEffort;
    initialAgents: string[];
  };
  configurableAgents: ReadonlyArray<{ key: string; label: string; desc: string }>;
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
  const [reasoning, setReasoning] = useState<ReasoningEffort>(
    assignment.initialReasoning,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(assignment.initialAgents),
  );

  const modelDisplayName =
    modelNamesById.get(assignment.modelId) ?? assignment.modelId;

  // Position a hidden anchor at the captured row rect so Radix anchors
  // the popover to the exact button the user clicked. Using virtualRef
  // would also work, but the inline anchor keeps the open/close
  // animation locked to the same element across renders.
  const anchorStyle: React.CSSProperties = {
    position: "fixed",
    left: assignment.rect.left,
    top: assignment.rect.top,
    width: assignment.rect.width,
    height: assignment.rect.height,
    pointerEvents: "none",
    visibility: "hidden",
  };

  const toggleAgent = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <PopoverPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <span style={anchorStyle} aria-hidden />
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-component="popover-content"
          className="models-assign-popover"
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={16}
          style={{ zIndex: 9999 }}
        >
          <header className="models-assign-head">
            <span className="models-assign-kicker">Apply</span>
            <span className="models-assign-title" title={modelDisplayName}>
              {modelDisplayName}
            </span>
          </header>

          <section
            className="models-assign-reasoning"
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
                  className="models-assign-reasoning-btn"
                  title={option.title}
                  onClick={() => setReasoning(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </section>

          <section className="models-assign-agents" role="group" aria-label="Agents">
            {configurableAgents.map((entry) => {
              const isChecked = selected.has(entry.key);
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
                  className="models-assign-agent-pill"
                  data-checked={isChecked || undefined}
                  data-current={sameModel || undefined}
                  title={title}
                  onClick={() => toggleAgent(entry.key)}
                >
                  {entry.label}
                </button>
              );
            })}
          </section>

          <footer className="models-assign-footer">
            <button
              type="button"
              className="models-assign-apply-all"
              disabled={pending}
              onClick={() => onApplyToAll(reasoning)}
              title="Apply this model to every configurable agent"
            >
              Apply to all
            </button>
            <div className="models-assign-footer-actions">
              <button
                type="button"
                className="models-assign-cancel"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="models-assign-apply"
                disabled={pending}
                onClick={() => onApply(Array.from(selected), reasoning)}
              >
                Apply
              </button>
            </div>
          </footer>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
