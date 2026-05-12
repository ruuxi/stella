/**
 * Local preferences — reads/writes `desktop/state/preferences.json`.
 *
 * Serves as the local source of truth for user preferences. Model routing
 * preferences live here only; Convex does not own or sync them.
 */

import fs from "fs";
import path from "path";
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from "../shared/private-fs.js";
import {
  DEFAULT_RADIAL_TRIGGER_CODE,
  normalizeRadialTriggerCode,
  type RadialTriggerCode,
} from "../../contracts/radial-trigger.js";
import {
  DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  normalizeMiniDoubleTapModifier,
  type MiniDoubleTapModifier,
} from "../../contracts/mini-double-tap.js";
import {
  coerceRealtimeVoiceProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceSelections,
  type RealtimeVoiceUnderlyingProvider,
} from "../../contracts/local-preferences.js";

type AgentEngine = "default" | "claude_code_local";
export type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ImageGenerationProvider =
  | "stella"
  | "openai"
  | "openrouter"
  | "fal";

export type ImageGenerationPreferences = {
  provider: ImageGenerationProvider;
  model?: string;
};

export type {
  RealtimeVoiceProvider,
  RealtimeVoiceUnderlyingProvider,
  RealtimeVoiceSelections,
  RealtimeVoicePreferences,
} from "../../contracts/local-preferences.js";
export { resolveRealtimeUnderlyingProvider } from "../../contracts/local-preferences.js";

export type LocalPreferences = {
  /** Default models keyed by agent type. */
  defaultModels: Record<string, string>;
  /** Model overrides keyed by agent type, e.g. "orchestrator" -> "anthropic/claude-opus-4.6" */
  modelOverrides: Record<string, string>;
  /** Reasoning effort overrides keyed by agent type. */
  reasoningEfforts: Record<string, ReasoningEffort>;
  /** Expression style: "none" | "emoji" | undefined (default) */
  expressionStyle?: string;
  /**
   * Selected personality voice id (see PERSONALITY_VOICES catalog).
   * Undefined falls back to the default voice.
   */
  personalityVoiceId?: string;
  /** Runtime engine shared by every local CLI-backed agent. */
  agentRuntimeEngine: AgentEngine;
  /** Shared max concurrency across all agent task execution */
  maxAgentConcurrency: number;
  /** Image generation provider/model. Stella is the managed default. */
  imageGeneration: ImageGenerationPreferences;
  /** Realtime voice provider/model. Stella is the managed default. */
  realtimeVoice: RealtimeVoicePreferences;
  /** Sync mode: "on" | "off". Defaults to off so cloud persistence is opt-in. */
  syncMode: "on" | "off";
  /** Hold key used to open the radial dial. */
  radialTriggerKey: RadialTriggerCode;
  /** Global accelerator used for OS-wide and in-app dictation. Empty disables it. */
  dictationShortcut: string;
  /** Global accelerator used to open the voice agent. Empty disables it. */
  voiceRtcShortcut: string;
  /** Modifier key double-tap used to toggle the mini window. Off disables it. */
  miniDoubleTapModifier: MiniDoubleTapModifier;
  /** Prevents the computer from sleeping while Stella is running. */
  preventComputerSleep: boolean;
  /** Allows desktop notification sounds for agent completion. */
  soundNotificationsEnabled: boolean;
  /** Allows start/stop sound effects for dictation. */
  dictationSoundEffectsEnabled: boolean;
  /**
   * "Hey Stella" wake-word listener — when enabled, a background
   * native helper continuously listens for the wake word and starts
   * the realtime voice agent on detection. Mic buttons / keybinds
   * remain dictation-only; voice is wake-word-gated.
   */
  wakeWordEnabled: boolean;
  /** Wake-word detection threshold (0–1). Higher = stricter. */
  wakeWordThreshold: number;
};

export type LocalModelPreferencesSnapshot = Pick<
  LocalPreferences,
  | "defaultModels"
  | "modelOverrides"
  | "reasoningEfforts"
  | "agentRuntimeEngine"
  | "maxAgentConcurrency"
  | "imageGeneration"
  | "realtimeVoice"
>;

const DEFAULT_MAX_AGENT_CONCURRENCY = 24;
const MAX_AGENT_CONCURRENCY_CEILING = 48;

const DEFAULT_PREFERENCES: LocalPreferences = {
  defaultModels: {},
  modelOverrides: {},
  reasoningEfforts: {},
  expressionStyle: undefined,
  personalityVoiceId: undefined,
  agentRuntimeEngine: "default",
  maxAgentConcurrency: DEFAULT_MAX_AGENT_CONCURRENCY,
  imageGeneration: { provider: "stella" },
  realtimeVoice: { provider: "stella" },
  syncMode: "off",
  radialTriggerKey: DEFAULT_RADIAL_TRIGGER_CODE,
  dictationShortcut: "Alt",
  voiceRtcShortcut: "CommandOrControl+Shift+D",
  miniDoubleTapModifier: DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  preventComputerSleep: false,
  soundNotificationsEnabled: true,
  dictationSoundEffectsEnabled: true,
  wakeWordEnabled: false,
  wakeWordThreshold: 0.68,
};

let _cached: LocalPreferences | null = null;
let _cachedMtime: number | null = null;

const prefsPath = (stellaHome: string) =>
  path.join(stellaHome, "state", "preferences.json");

export const loadLocalPreferences = (stellaHome: string): LocalPreferences => {
  const filePath = prefsPath(stellaHome);

  try {
    const stat = fs.statSync(filePath);
    if (_cached && _cachedMtime === stat.mtimeMs) {
      return _cached;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LocalPreferences>;
    const prefs: LocalPreferences = {
      ...DEFAULT_PREFERENCES,
      defaultModels: parsed.defaultModels ?? DEFAULT_PREFERENCES.defaultModels,
      modelOverrides:
        parsed.modelOverrides ?? DEFAULT_PREFERENCES.modelOverrides,
      reasoningEfforts: normalizeReasoningEfforts(parsed.reasoningEfforts),
      expressionStyle: parsed.expressionStyle,
      personalityVoiceId:
        typeof parsed.personalityVoiceId === "string" &&
        parsed.personalityVoiceId.trim().length > 0
          ? parsed.personalityVoiceId.trim()
          : DEFAULT_PREFERENCES.personalityVoiceId,
      agentRuntimeEngine: normalizeEngine(parsed.agentRuntimeEngine),
      maxAgentConcurrency: normalizeConcurrency(parsed.maxAgentConcurrency),
      imageGeneration: normalizeImageGenerationPreferences(
        parsed.imageGeneration,
      ),
      realtimeVoice: normalizeRealtimeVoicePreferences(parsed.realtimeVoice),
      syncMode: parsed.syncMode === "on" ? "on" : "off",
      radialTriggerKey: normalizeRadialTriggerCode(parsed.radialTriggerKey),
      dictationShortcut:
        typeof parsed.dictationShortcut === "string"
          ? parsed.dictationShortcut
          : DEFAULT_PREFERENCES.dictationShortcut,
      voiceRtcShortcut:
        typeof parsed.voiceRtcShortcut === "string"
          ? parsed.voiceRtcShortcut
          : DEFAULT_PREFERENCES.voiceRtcShortcut,
      miniDoubleTapModifier: normalizeMiniDoubleTapModifier(
        parsed.miniDoubleTapModifier,
      ),
      preventComputerSleep: parsed.preventComputerSleep === true,
      soundNotificationsEnabled: parsed.soundNotificationsEnabled !== false,
      dictationSoundEffectsEnabled:
        parsed.dictationSoundEffectsEnabled !== false,
      wakeWordEnabled:
        typeof parsed.wakeWordEnabled === "boolean"
          ? parsed.wakeWordEnabled
          : DEFAULT_PREFERENCES.wakeWordEnabled,
      wakeWordThreshold:
        typeof parsed.wakeWordThreshold === "number" &&
        Number.isFinite(parsed.wakeWordThreshold) &&
        parsed.wakeWordThreshold > 0 &&
        parsed.wakeWordThreshold <= 1
          ? parsed.wakeWordThreshold
          : DEFAULT_PREFERENCES.wakeWordThreshold,
    };
    _cached = prefs;
    _cachedMtime = stat.mtimeMs;
    return prefs;
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
};

export const saveLocalPreferences = (
  stellaHome: string,
  prefs: LocalPreferences,
): void => {
  const filePath = prefsPath(stellaHome);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    ensurePrivateDirSync(dir);
  }
  writePrivateFileSync(filePath, JSON.stringify(prefs, null, 2));
  _cached = prefs;
  try {
    _cachedMtime = fs.statSync(filePath).mtimeMs;
  } catch {
    _cachedMtime = null;
  }
};

export const getModelOverride = (
  stellaHome: string,
  agentType: string,
): string | undefined => {
  const prefs = loadLocalPreferences(stellaHome);
  return prefs.modelOverrides[agentType];
};

export const getDefaultModel = (
  stellaHome: string,
  agentType: string,
): string | undefined => {
  const prefs = loadLocalPreferences(stellaHome);
  return prefs.defaultModels[agentType];
};

export const getReasoningEffort = (
  stellaHome: string,
  agentType: string,
): ReasoningEffort => {
  const prefs = loadLocalPreferences(stellaHome);
  return normalizeReasoningEffort(prefs.reasoningEfforts[agentType]);
};

export const getExpressionStyle = (stellaHome: string): string | undefined => {
  return loadLocalPreferences(stellaHome).expressionStyle;
};

export const getPersonalityVoiceId = (
  stellaHome: string,
): string | undefined => {
  return loadLocalPreferences(stellaHome).personalityVoiceId;
};

export const setPersonalityVoiceId = (
  stellaHome: string,
  voiceId: string | undefined,
): void => {
  const prefs = loadLocalPreferences(stellaHome);
  const next: LocalPreferences = {
    ...prefs,
    personalityVoiceId:
      typeof voiceId === "string" && voiceId.trim().length > 0
        ? voiceId.trim()
        : undefined,
  };
  saveLocalPreferences(stellaHome, next);
};

export const getAgentRuntimeEngine = (stellaHome: string): AgentEngine => {
  return loadLocalPreferences(stellaHome).agentRuntimeEngine;
};

export const getMaxAgentConcurrency = (stellaHome: string): number => {
  return loadLocalPreferences(stellaHome).maxAgentConcurrency;
};

export const getImageGenerationPreferences = (
  stellaHome: string,
): ImageGenerationPreferences => {
  return normalizeImageGenerationPreferences(
    loadLocalPreferences(stellaHome).imageGeneration,
  );
};

export const getRealtimeVoicePreferences = (
  stellaHome: string,
): RealtimeVoicePreferences => {
  return normalizeRealtimeVoicePreferences(
    loadLocalPreferences(stellaHome).realtimeVoice,
  );
};

export const getLocalModelPreferences = (
  stellaHome: string,
): LocalModelPreferencesSnapshot => {
  const prefs = loadLocalPreferences(stellaHome);
  return {
    defaultModels: { ...prefs.defaultModels },
    modelOverrides: { ...prefs.modelOverrides },
    reasoningEfforts: { ...prefs.reasoningEfforts },
    agentRuntimeEngine: prefs.agentRuntimeEngine,
    maxAgentConcurrency: prefs.maxAgentConcurrency,
    imageGeneration: { ...prefs.imageGeneration },
    realtimeVoice: { ...prefs.realtimeVoice },
  };
};

export const updateLocalModelPreferences = (
  stellaHome: string,
  patch: Partial<LocalModelPreferencesSnapshot>,
): LocalModelPreferencesSnapshot => {
  const prefs = loadLocalPreferences(stellaHome);
  const next: LocalPreferences = {
    ...prefs,
    defaultModels: patch.defaultModels ?? prefs.defaultModels,
    modelOverrides: patch.modelOverrides ?? prefs.modelOverrides,
    reasoningEfforts:
      patch.reasoningEfforts === undefined
        ? prefs.reasoningEfforts
        : normalizeReasoningEfforts(patch.reasoningEfforts),
    agentRuntimeEngine:
      patch.agentRuntimeEngine === undefined
        ? prefs.agentRuntimeEngine
        : normalizeEngine(patch.agentRuntimeEngine),
    maxAgentConcurrency:
      patch.maxAgentConcurrency === undefined
        ? prefs.maxAgentConcurrency
        : normalizeConcurrency(patch.maxAgentConcurrency),
    imageGeneration:
      patch.imageGeneration === undefined
        ? prefs.imageGeneration
        : normalizeImageGenerationPreferences(patch.imageGeneration),
    realtimeVoice:
      patch.realtimeVoice === undefined
        ? prefs.realtimeVoice
        : normalizeRealtimeVoicePreferences(patch.realtimeVoice),
  };
  saveLocalPreferences(stellaHome, next);
  return getLocalModelPreferences(stellaHome);
};

/**
 * Resolve the model name for the Explore agent. Prefers an explicit override
 * (modelOverrides["explore"]), then a local default
 * (defaultModels["explore"]), then returns undefined to let resolveLlmRoute
 * fall back to STELLA_DEFAULT_MODEL.
 *
 * Explore is meant to be a fast cheap pass over state/. Users who want to
 * spend more should set modelOverrides["explore"] explicitly.
 */
export const getExploreModel = (stellaHome: string): string | undefined => {
  const prefs = loadLocalPreferences(stellaHome);
  return prefs.modelOverrides["explore"] ?? prefs.defaultModels["explore"];
};

export const getSyncMode = (stellaHome: string): "on" | "off" => {
  return loadLocalPreferences(stellaHome).syncMode;
};

export const getPreventComputerSleep = (stellaHome: string): boolean => {
  return loadLocalPreferences(stellaHome).preventComputerSleep;
};

export const getSoundNotificationsEnabled = (stellaHome: string): boolean => {
  return loadLocalPreferences(stellaHome).soundNotificationsEnabled;
};

export const getDictationSoundEffectsEnabled = (
  stellaHome: string,
): boolean => {
  return loadLocalPreferences(stellaHome).dictationSoundEffectsEnabled;
};

// ── Normalization helpers ─────────────────────────────────────────────────

const normalizeEngine = (value: unknown): AgentEngine => {
  if (value === "claude_code_local") return "claude_code_local";
  return "default";
};

const normalizeReasoningEffort = (value: unknown): ReasoningEffort => {
  if (
    value === "default" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return "default";
};

const normalizeReasoningEfforts = (
  value: unknown,
): Record<string, ReasoningEffort> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const normalized: Record<string, ReasoningEffort> = {};
  for (const [agentType, effort] of Object.entries(value)) {
    const trimmedAgentType = agentType.trim();
    if (!trimmedAgentType) continue;
    normalized[trimmedAgentType] = normalizeReasoningEffort(effort);
  }
  return normalized;
};

const normalizeConcurrency = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_AGENT_CONCURRENCY;
  }
  const rounded = Math.floor(parsed);
  return Math.min(MAX_AGENT_CONCURRENCY_CEILING, rounded);
};

export const normalizeImageGenerationPreferences = (
  value: unknown,
): ImageGenerationPreferences => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { provider: "stella" };
  }
  const record = value as { provider?: unknown; model?: unknown };
  const provider =
    record.provider === "openai" ||
    record.provider === "openrouter" ||
    record.provider === "fal"
      ? record.provider
      : "stella";
  const model =
    typeof record.model === "string" && record.model.trim().length > 0
      ? record.model.trim()
      : undefined;
  return provider === "stella"
    ? { provider }
    : { provider, ...(model ? { model } : {}) };
};

const normalizeRealtimeVoiceSelections = (
  value: unknown,
): RealtimeVoiceSelections | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as {
    openai?: unknown;
    xai?: unknown;
    inworld?: unknown;
  };
  const out: RealtimeVoiceSelections = {};
  if (typeof record.openai === "string" && record.openai.trim().length > 0) {
    out.openai = record.openai.trim();
  }
  if (typeof record.xai === "string" && record.xai.trim().length > 0) {
    out.xai = record.xai.trim();
  }
  if (typeof record.inworld === "string" && record.inworld.trim().length > 0) {
    out.inworld = record.inworld.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const UNDERLYING_PROVIDERS: readonly RealtimeVoiceUnderlyingProvider[] = [
  "openai",
  "xai",
  "inworld",
];

const coerceUnderlyingProvider = (
  value: unknown,
): RealtimeVoiceUnderlyingProvider | undefined =>
  typeof value === "string" &&
  (UNDERLYING_PROVIDERS as readonly string[]).includes(value)
    ? (value as RealtimeVoiceUnderlyingProvider)
    : undefined;

const INWORLD_SPEED_MIN = 0.5;
const INWORLD_SPEED_MAX = 2.0;

export const normalizeRealtimeVoicePreferences = (
  value: unknown,
): RealtimeVoicePreferences => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { provider: "stella" };
  }
  const record = value as {
    provider?: unknown;
    model?: unknown;
    voices?: unknown;
    stellaSubProvider?: unknown;
    inworldSpeed?: unknown;
  };

  const provider = coerceRealtimeVoiceProvider(
    typeof record.provider === "string" ? record.provider : "",
  );
  const model =
    typeof record.model === "string" && record.model.trim().length > 0
      ? record.model.trim()
      : undefined;
  const voices = normalizeRealtimeVoiceSelections(record.voices);
  const stellaSubProvider = coerceUnderlyingProvider(record.stellaSubProvider);
  const inworldSpeed =
    typeof record.inworldSpeed === "number" &&
    Number.isFinite(record.inworldSpeed)
      ? Math.min(INWORLD_SPEED_MAX, Math.max(INWORLD_SPEED_MIN, record.inworldSpeed))
      : undefined;

  const result: RealtimeVoicePreferences = { provider };
  if (provider !== "stella" && model) result.model = model;
  if (voices) result.voices = voices;
  if (stellaSubProvider) result.stellaSubProvider = stellaSubProvider;
  if (inworldSpeed !== undefined) result.inworldSpeed = inworldSpeed;
  return result;
};

/**
 * Resolve the voice id that should be used for the active session, given
 * the user's preferences and the underlying provider that will actually
 * run the session.
 */
export const resolveRealtimeVoiceId = (
  prefs: RealtimeVoicePreferences,
  underlyingProvider: RealtimeVoiceUnderlyingProvider,
  fallback: string,
): string => {
  const stored = prefs.voices?.[underlyingProvider]?.trim();
  return stored && stored.length > 0 ? stored : fallback;
};
