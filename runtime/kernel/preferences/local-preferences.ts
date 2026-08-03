/**
 * Local preferences — reads/writes `~/.stella/preferences.json`.
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
  coerceRealtimeVoiceProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceSelections,
  type RealtimeVoiceUnderlyingProvider,
} from "../../contracts/local-preferences.js";
import {
  coerceAgentRuntimeEngine,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_SERVICE_TIER,
  type AgentRuntimeEngine,
  type CodexServiceTier,
} from "../../contracts/agent-engine.js";
import {
  isKnownPersonalityId,
  type PersonalityId,
} from "../../contracts/personality.js";

type AgentEngine = AgentRuntimeEngine;
export { DEFAULT_CODEX_MODEL } from "../../contracts/agent-engine.js";
export const DEFAULT_CLAUDE_CODE_MODEL = "default";
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
  ReadAloudVoiceProvider,
} from "../../contracts/local-preferences.js";
export {
  resolveRealtimeUnderlyingProvider,
  resolveReadAloudProvider,
} from "../../contracts/local-preferences.js";

export type LocalPreferences = {
  /** Default models keyed by agent type. */
  defaultModels: Record<string, string>;
  /** Model overrides keyed by agent type, e.g. "orchestrator" -> "anthropic/claude-opus-4.6" */
  modelOverrides: Record<string, string>;
  /**
   * Agent keys whose current entry in `modelOverrides` was written by
   * Assistant-tab auto-propagation (not by an explicit per-agent pick).
   * The Assistant tab in `AgentModelPicker` writes orchestrator + general
   * directly and broadcasts the same model to every other configurable
   * agent (except chronicle, which is intentionally explicit-opt-in). We
   * track which keys were propagation-written so switching Assistant back
   * to Stella only clears those, never user-intentional per-agent picks.
   */
  assistantPropagatedAgents: string[];
  /** Reasoning effort overrides keyed by agent type. */
  reasoningEfforts: Record<string, ReasoningEffort>;
  /** Conversation routes to restore when leaving a local runtime engine. */
  stellaConversationModelOverrides: Record<string, string>;
  /** Stella-scoped conversation reasoning restored with its routes. */
  stellaConversationReasoningEfforts: Record<string, ReasoningEffort>;
  /** Runtime engine shared by every local CLI-backed agent. */
  agentRuntimeEngine: AgentEngine;
  /** Opt Codex General/subagent runs into the native app-server boundary. */
  useNativeCodexRuntime: boolean;
  /** Opt Claude General/subagent runs into vanilla Claude Code. */
  useNativeClaudeCodeRuntime: boolean;
  /** Codex model id used when the Codex engine is selected. */
  codexModel: string;
  /**
   * True once the user actively picks a Codex/ChatGPT model in a picker
   * surface. Distinguishes an explicit pick from a materialized default that
   * legacy prefs.json bake into `codexModel`. Only an explicit pick makes
   * Stella Light honor the saved model instead of downgrading to the light
   * model. Absent/false on legacy files => treated as non-explicit.
   */
  codexModelExplicit: boolean;
  /** Codex reasoning effort used when the Codex engine is selected. */
  codexReasoningEffort: ReasoningEffort;
  /** ChatGPT/Codex request speed used when the Codex engine is selected. */
  codexServiceTier: CodexServiceTier;
  /** Claude Code model or alias used when the Claude Code engine is selected. */
  claudeCodeModel: string;
  /** Claude Code effort/thinking level used when the Claude Code engine is selected. */
  claudeCodeReasoningEffort: ReasoningEffort;
  /** Shared max concurrency across all agent task execution */
  maxAgentConcurrency: number;
  /** Image generation provider/model. Stella is the managed default. */
  imageGeneration: ImageGenerationPreferences;
  /** Realtime voice provider/model. Stella is the managed default. */
  realtimeVoice: RealtimeVoicePreferences;
  /** Sync mode: "on" | "off". Defaults to off so cloud persistence is opt-in. */
  syncMode: "on" | "off";
  /** Global accelerator used for OS-wide and in-app dictation. Empty disables it. */
  dictationShortcut: string;
  /** Global accelerator used to open the voice agent. Empty disables it. */
  voiceRtcShortcut: string;
  /** Prevents the computer from sleeping while Stella is running. */
  preventComputerSleep: boolean;
  /** Allows Stella computer use to continue through the macOS lock screen. */
  lockedComputerUseEnabled: boolean;
  /** Allows desktop notification sounds for agent completion. */
  soundNotificationsEnabled: boolean;
  /** Allows start/stop sound effects for dictation. */
  dictationSoundEffectsEnabled: boolean;
  /**
   * Reads finalized assistant messages aloud via one-shot TTS. Off by
   * default — the user opts in from a speaker toggle in the chat UI. The
   * provider is `realtimeVoice.readAloudProvider` (defaults to Inworld),
   * independent from the realtime voice agent.
   */
  readAloudEnabled: boolean;
  /**
   * Live Memory (Chronicle screen capture/OCR) is opt-in. Onboarding may
   * stage an enable while waiting for sign-in, then promote it after auth.
   */
  chronicleEnabled: boolean;
  chroniclePendingEnable: boolean;
  /**
   * "Hey Stella" wake-word listener — when enabled, a background
   * native helper continuously listens for the wake word and starts
   * the realtime voice agent on detection. Mic buttons / keybinds
   * remain dictation-only; voice is wake-word-gated.
   */
  wakeWordEnabled: boolean;
  /**
   * First-run onboarding completion. Stored in ~/.stella/preferences.json so
   * launcher reinstall/repair flows preserve it even if Electron web storage
   * is rebuilt.
   */
  onboardingCompleted: boolean;
  /** Wake-word detection threshold (0–1). Higher = stricter. */
  wakeWordThreshold: number;
  /**
   * Selected personality preset id (see PERSONALITY_OPTIONS). Drives which
   * preset seeds `~/.stella/PERSONALITY.md`. Undefined falls back to the
   * Stella default.
   */
  personalityVoiceId?: PersonalityId;
};

export type LocalModelPreferencesSnapshot = Pick<
  LocalPreferences,
  | "defaultModels"
  | "modelOverrides"
  | "assistantPropagatedAgents"
  | "reasoningEfforts"
  | "stellaConversationModelOverrides"
  | "stellaConversationReasoningEfforts"
  | "agentRuntimeEngine"
  | "useNativeCodexRuntime"
  | "useNativeClaudeCodeRuntime"
  | "codexModel"
  | "codexModelExplicit"
  | "codexReasoningEffort"
  | "codexServiceTier"
  | "claudeCodeModel"
  | "claudeCodeReasoningEffort"
  | "maxAgentConcurrency"
  | "imageGeneration"
  | "realtimeVoice"
>;

const DEFAULT_MAX_AGENT_CONCURRENCY = 24;
const MAX_AGENT_CONCURRENCY_CEILING = 48;

const DEFAULT_PREFERENCES: LocalPreferences = {
  defaultModels: {},
  modelOverrides: {},
  assistantPropagatedAgents: [],
  reasoningEfforts: {
    orchestrator: "low",
    general: "low",
  },
  stellaConversationModelOverrides: {},
  stellaConversationReasoningEfforts: {},
  agentRuntimeEngine: "default",
  useNativeCodexRuntime: false,
  useNativeClaudeCodeRuntime: false,
  codexModel: DEFAULT_CODEX_MODEL,
  codexModelExplicit: false,
  codexReasoningEffort: "default",
  codexServiceTier: DEFAULT_CODEX_SERVICE_TIER,
  claudeCodeModel: DEFAULT_CLAUDE_CODE_MODEL,
  claudeCodeReasoningEffort: "default",
  maxAgentConcurrency: DEFAULT_MAX_AGENT_CONCURRENCY,
  imageGeneration: { provider: "stella" },
  realtimeVoice: { provider: "stella" },
  syncMode: "off",
  dictationShortcut: "Alt",
  voiceRtcShortcut: "CommandOrControl+Shift+D",
  preventComputerSleep: false,
  lockedComputerUseEnabled: false,
  soundNotificationsEnabled: true,
  dictationSoundEffectsEnabled: true,
  wakeWordEnabled: false,
  onboardingCompleted: false,
  wakeWordThreshold: 0.6,
  readAloudEnabled: false,
  chronicleEnabled: false,
  chroniclePendingEnable: false,
  personalityVoiceId: undefined,
};

const LEGACY_STELLA_DEFAULT_MODEL = "stella/default";
const RETIRED_MODEL_PROVIDERS = new Set([
  "google-antigravity",
  "google-gemini-cli",
]);

let _cached: LocalPreferences | null = null;
let _cachedMtime: number | null = null;

const prefsPath = (stellaDataDir: string) =>
  path.join(stellaDataDir, "preferences.json");

type PersistedLocalPreferences = Partial<LocalPreferences> & {
  /** Retired global native-runtime opt-out, read only for split migration. */
  useNativeAgentRuntimes?: unknown;
  /** Older harness opt-in key, intentionally ignored. */
  subscriptionHarnessEnabled?: unknown;
};

export const loadLocalPreferences = (
  stellaDataDir: string,
): LocalPreferences => {
  const filePath = prefsPath(stellaDataDir);

  try {
    const stat = fs.statSync(filePath);
    if (_cached && _cachedMtime === stat.mtimeMs) {
      return _cached;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedLocalPreferences;
    const prefs: LocalPreferences = {
      ...DEFAULT_PREFERENCES,
      defaultModels: normalizeModelPreferenceMap(parsed.defaultModels),
      modelOverrides: normalizeModelPreferenceMap(parsed.modelOverrides),
      assistantPropagatedAgents: normalizeAssistantPropagatedAgents(
        parsed.assistantPropagatedAgents,
      ),
      reasoningEfforts: normalizeReasoningEfforts(parsed.reasoningEfforts),
      stellaConversationModelOverrides: normalizeModelPreferenceMap(
        parsed.stellaConversationModelOverrides,
      ),
      stellaConversationReasoningEfforts: normalizeReasoningEfforts(
        parsed.stellaConversationReasoningEfforts,
      ),
      agentRuntimeEngine: normalizeEngine(parsed.agentRuntimeEngine),
      // The short-lived global native-runtime opt-out is migrated per engine
      // only when that engine's replacement key is absent. Its default false
      // (and the older `subscriptionHarnessEnabled` key) never change the new
      // harness-by-default behavior. Saving the normalized object strips both
      // retired keys.
      useNativeCodexRuntime:
        typeof parsed.useNativeCodexRuntime === "boolean"
          ? parsed.useNativeCodexRuntime
          : parsed.useNativeAgentRuntimes === true,
      useNativeClaudeCodeRuntime:
        typeof parsed.useNativeClaudeCodeRuntime === "boolean"
          ? parsed.useNativeClaudeCodeRuntime
          : parsed.useNativeAgentRuntimes === true,
      codexModel: normalizeCodexModel(parsed.codexModel),
      codexModelExplicit: parsed.codexModelExplicit === true,
      codexReasoningEffort: normalizeReasoningEffort(
        parsed.codexReasoningEffort,
      ),
      codexServiceTier: normalizeCodexServiceTier(parsed.codexServiceTier),
      claudeCodeModel: normalizeClaudeCodeModel(parsed.claudeCodeModel),
      claudeCodeReasoningEffort:
        normalizeReasoningEffort(parsed.claudeCodeReasoningEffort) === "minimal"
          ? "low"
          : normalizeReasoningEffort(parsed.claudeCodeReasoningEffort),
      maxAgentConcurrency: normalizeConcurrency(parsed.maxAgentConcurrency),
      imageGeneration: normalizeImageGenerationPreferences(
        parsed.imageGeneration,
      ),
      realtimeVoice: normalizeRealtimeVoicePreferences(parsed.realtimeVoice),
      syncMode: parsed.syncMode === "on" ? "on" : "off",
      dictationShortcut:
        typeof parsed.dictationShortcut === "string"
          ? parsed.dictationShortcut
          : DEFAULT_PREFERENCES.dictationShortcut,
      voiceRtcShortcut:
        typeof parsed.voiceRtcShortcut === "string"
          ? parsed.voiceRtcShortcut
          : DEFAULT_PREFERENCES.voiceRtcShortcut,
      preventComputerSleep: parsed.preventComputerSleep === true,
      lockedComputerUseEnabled: parsed.lockedComputerUseEnabled === true,
      soundNotificationsEnabled: parsed.soundNotificationsEnabled !== false,
      dictationSoundEffectsEnabled:
        parsed.dictationSoundEffectsEnabled !== false,
      wakeWordEnabled:
        typeof parsed.wakeWordEnabled === "boolean"
          ? parsed.wakeWordEnabled
          : DEFAULT_PREFERENCES.wakeWordEnabled,
      onboardingCompleted: parsed.onboardingCompleted === true,
      wakeWordThreshold:
        typeof parsed.wakeWordThreshold === "number" &&
        Number.isFinite(parsed.wakeWordThreshold) &&
        parsed.wakeWordThreshold > 0 &&
        parsed.wakeWordThreshold <= 1
          ? parsed.wakeWordThreshold
          : DEFAULT_PREFERENCES.wakeWordThreshold,
      readAloudEnabled: parsed.readAloudEnabled === true,
      chronicleEnabled: parsed.chronicleEnabled === true,
      chroniclePendingEnable:
        parsed.chronicleEnabled !== true &&
        parsed.chroniclePendingEnable === true,
      personalityVoiceId: isKnownPersonalityId(parsed.personalityVoiceId)
        ? parsed.personalityVoiceId
        : DEFAULT_PREFERENCES.personalityVoiceId,
    };
    _cached = prefs;
    _cachedMtime = stat.mtimeMs;
    return prefs;
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
};

export const saveLocalPreferences = (
  stellaDataDir: string,
  prefs: LocalPreferences,
): void => {
  const filePath = prefsPath(stellaDataDir);
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
  stellaDataDir: string,
  agentType: string,
): string | undefined => {
  const prefs = loadLocalPreferences(stellaDataDir);
  return prefs.modelOverrides[agentType];
};

export const getReasoningEffort = (
  stellaDataDir: string,
  agentType: string,
): ReasoningEffort => {
  const prefs = loadLocalPreferences(stellaDataDir);
  return normalizeReasoningEffort(prefs.reasoningEfforts[agentType]);
};

export const getAgentRuntimeEngine = (stellaDataDir: string): AgentEngine => {
  return loadLocalPreferences(stellaDataDir).agentRuntimeEngine;
};

export const getSubscriptionHarnessEnabled = (
  stellaDataDir: string,
  engine: AgentRuntimeEngine,
): boolean => {
  const prefs = loadLocalPreferences(stellaDataDir);
  if (engine === "codex_cli") return !prefs.useNativeCodexRuntime;
  if (engine === "claude_code_local") {
    return !prefs.useNativeClaudeCodeRuntime;
  }
  return false;
};

export const getMaxAgentConcurrency = (stellaDataDir: string): number => {
  return loadLocalPreferences(stellaDataDir).maxAgentConcurrency;
};

export const getImageGenerationPreferences = (
  stellaDataDir: string,
): ImageGenerationPreferences => {
  return normalizeImageGenerationPreferences(
    loadLocalPreferences(stellaDataDir).imageGeneration,
  );
};

export const getRealtimeVoicePreferences = (
  stellaDataDir: string,
): RealtimeVoicePreferences => {
  return normalizeRealtimeVoicePreferences(
    loadLocalPreferences(stellaDataDir).realtimeVoice,
  );
};

export const getLocalModelPreferences = (
  stellaDataDir: string,
): LocalModelPreferencesSnapshot => {
  const prefs = loadLocalPreferences(stellaDataDir);
  return {
    defaultModels: { ...prefs.defaultModels },
    modelOverrides: { ...prefs.modelOverrides },
    assistantPropagatedAgents: [...prefs.assistantPropagatedAgents],
    reasoningEfforts: { ...prefs.reasoningEfforts },
    stellaConversationModelOverrides: {
      ...prefs.stellaConversationModelOverrides,
    },
    stellaConversationReasoningEfforts: {
      ...prefs.stellaConversationReasoningEfforts,
    },
    agentRuntimeEngine: prefs.agentRuntimeEngine,
    useNativeCodexRuntime: prefs.useNativeCodexRuntime,
    useNativeClaudeCodeRuntime: prefs.useNativeClaudeCodeRuntime,
    codexModel: prefs.codexModel,
    codexModelExplicit: prefs.codexModelExplicit,
    codexReasoningEffort: prefs.codexReasoningEffort,
    codexServiceTier: prefs.codexServiceTier,
    claudeCodeModel: prefs.claudeCodeModel,
    claudeCodeReasoningEffort: prefs.claudeCodeReasoningEffort,
    maxAgentConcurrency: prefs.maxAgentConcurrency,
    imageGeneration: { ...prefs.imageGeneration },
    realtimeVoice: { ...prefs.realtimeVoice },
  };
};

export const updateLocalModelPreferences = (
  stellaDataDir: string,
  patch: Partial<LocalModelPreferencesSnapshot>,
): LocalModelPreferencesSnapshot => {
  const prefs = loadLocalPreferences(stellaDataDir);
  const next: LocalPreferences = {
    ...prefs,
    defaultModels:
      patch.defaultModels === undefined
        ? prefs.defaultModels
        : normalizeModelPreferenceMap(patch.defaultModels),
    modelOverrides:
      patch.modelOverrides === undefined
        ? prefs.modelOverrides
        : normalizeModelPreferenceMap(patch.modelOverrides),
    assistantPropagatedAgents:
      patch.assistantPropagatedAgents === undefined
        ? prefs.assistantPropagatedAgents
        : normalizeAssistantPropagatedAgents(patch.assistantPropagatedAgents),
    reasoningEfforts:
      patch.reasoningEfforts === undefined
        ? prefs.reasoningEfforts
        : normalizeReasoningEfforts(patch.reasoningEfforts),
    stellaConversationModelOverrides:
      patch.stellaConversationModelOverrides === undefined
        ? prefs.stellaConversationModelOverrides
        : normalizeModelPreferenceMap(patch.stellaConversationModelOverrides),
    stellaConversationReasoningEfforts:
      patch.stellaConversationReasoningEfforts === undefined
        ? prefs.stellaConversationReasoningEfforts
        : normalizeReasoningEfforts(patch.stellaConversationReasoningEfforts),
    agentRuntimeEngine:
      patch.agentRuntimeEngine === undefined
        ? prefs.agentRuntimeEngine
        : normalizeEngine(patch.agentRuntimeEngine),
    useNativeCodexRuntime:
      patch.useNativeCodexRuntime === undefined
        ? prefs.useNativeCodexRuntime
        : patch.useNativeCodexRuntime === true,
    useNativeClaudeCodeRuntime:
      patch.useNativeClaudeCodeRuntime === undefined
        ? prefs.useNativeClaudeCodeRuntime
        : patch.useNativeClaudeCodeRuntime === true,
    codexModel:
      patch.codexModel === undefined
        ? prefs.codexModel
        : normalizeCodexModel(patch.codexModel),
    codexModelExplicit:
      patch.codexModelExplicit === undefined
        ? prefs.codexModelExplicit
        : patch.codexModelExplicit === true,
    codexReasoningEffort:
      patch.codexReasoningEffort === undefined
        ? prefs.codexReasoningEffort
        : normalizeReasoningEffort(patch.codexReasoningEffort),
    codexServiceTier:
      patch.codexServiceTier === undefined
        ? prefs.codexServiceTier
        : normalizeCodexServiceTier(patch.codexServiceTier),
    claudeCodeModel:
      patch.claudeCodeModel === undefined
        ? prefs.claudeCodeModel
        : normalizeClaudeCodeModel(patch.claudeCodeModel),
    claudeCodeReasoningEffort:
      patch.claudeCodeReasoningEffort === undefined
        ? prefs.claudeCodeReasoningEffort
        : normalizeReasoningEffort(patch.claudeCodeReasoningEffort) ===
            "minimal"
          ? "low"
          : normalizeReasoningEffort(patch.claudeCodeReasoningEffort),
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
  saveLocalPreferences(stellaDataDir, next);
  return getLocalModelPreferences(stellaDataDir);
};

/**
 * Resolve the model name for the Explore agent. Prefers an explicit override
 * (modelOverrides["explore"]), then returns undefined to let resolveLlmRoute
 * fall back to Stella's backend-owned default.
 *
 * Explore is meant to be a fast cheap pass over ~/.stella/. Users who want to
 * spend more should set modelOverrides["explore"] explicitly.
 */
export const getExploreModel = (stellaDataDir: string): string | undefined => {
  const prefs = loadLocalPreferences(stellaDataDir);
  return prefs.modelOverrides["explore"];
};

export const getSyncMode = (stellaDataDir: string): "on" | "off" => {
  return loadLocalPreferences(stellaDataDir).syncMode;
};

export const getPreventComputerSleep = (stellaDataDir: string): boolean => {
  return loadLocalPreferences(stellaDataDir).preventComputerSleep;
};

export const getLockedComputerUseEnabled = (stellaDataDir: string): boolean => {
  return loadLocalPreferences(stellaDataDir).lockedComputerUseEnabled;
};

export const getSoundNotificationsEnabled = (
  stellaDataDir: string,
): boolean => {
  return loadLocalPreferences(stellaDataDir).soundNotificationsEnabled;
};

export const getDictationSoundEffectsEnabled = (
  stellaDataDir: string,
): boolean => {
  return loadLocalPreferences(stellaDataDir).dictationSoundEffectsEnabled;
};

export const getReadAloudEnabled = (stellaDataDir: string): boolean => {
  return loadLocalPreferences(stellaDataDir).readAloudEnabled;
};

export const setReadAloudEnabled = (
  stellaDataDir: string,
  enabled: boolean,
): void => {
  const prefs = loadLocalPreferences(stellaDataDir);
  saveLocalPreferences(stellaDataDir, { ...prefs, readAloudEnabled: enabled });
};

export const getChronicleEnabled = (stellaDataDir: string): boolean => {
  return loadLocalPreferences(stellaDataDir).chronicleEnabled;
};

export const getChroniclePendingEnable = (stellaDataDir: string): boolean => {
  const prefs = loadLocalPreferences(stellaDataDir);
  return (
    prefs.chronicleEnabled !== true && prefs.chroniclePendingEnable === true
  );
};

export const setChronicleMemoryPreference = (
  stellaDataDir: string,
  value: { enabled: boolean; pendingEnable?: boolean },
): void => {
  const prefs = loadLocalPreferences(stellaDataDir);
  saveLocalPreferences(stellaDataDir, {
    ...prefs,
    chronicleEnabled: value.enabled,
    chroniclePendingEnable:
      value.enabled === true ? false : value.pendingEnable === true,
  });
};

export const getPersonalityVoiceId = (
  stellaDataDir: string,
): PersonalityId | undefined =>
  loadLocalPreferences(stellaDataDir).personalityVoiceId;

export const setPersonalityVoiceId = (
  stellaDataDir: string,
  id: PersonalityId,
): void => {
  const prefs = loadLocalPreferences(stellaDataDir);
  saveLocalPreferences(stellaDataDir, { ...prefs, personalityVoiceId: id });
};

export const getOnboardingCompleted = (stellaDataDir: string): boolean =>
  loadLocalPreferences(stellaDataDir).onboardingCompleted;

export const setOnboardingCompleted = (
  stellaDataDir: string,
  completed: boolean,
): void => {
  const prefs = loadLocalPreferences(stellaDataDir);
  saveLocalPreferences(stellaDataDir, {
    ...prefs,
    onboardingCompleted: completed,
  });
};

// ── Normalization helpers ─────────────────────────────────────────────────

const normalizeEngine = (value: unknown): AgentEngine => {
  return coerceAgentRuntimeEngine(value);
};

const normalizeCodexModel = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_CODEX_MODEL;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_CODEX_MODEL;
};

const normalizeClaudeCodeModel = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_CLAUDE_CODE_MODEL;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_CLAUDE_CODE_MODEL;
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

export const normalizeCodexServiceTier = (value: unknown): CodexServiceTier =>
  value === "fast" ? "fast" : DEFAULT_CODEX_SERVICE_TIER;

const normalizeAssistantPropagatedAgents = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const normalizeModelPreferenceMap = (
  value: unknown,
): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [agentType, model] of Object.entries(value)) {
    const trimmedAgentType = agentType.trim();
    const trimmedModel = typeof model === "string" ? model.trim() : "";
    if (!trimmedAgentType || !trimmedModel) continue;
    if (trimmedModel === LEGACY_STELLA_DEFAULT_MODEL) continue;
    if (RETIRED_MODEL_PROVIDERS.has(trimmedModel.split("/", 1)[0] ?? "")) {
      continue;
    }
    normalized[trimmedAgentType] = trimmedModel;
  }
  return normalized;
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
    readAloudProvider?: unknown;
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
      ? Math.min(
          INWORLD_SPEED_MAX,
          Math.max(INWORLD_SPEED_MIN, record.inworldSpeed),
        )
      : undefined;
  const readAloudProvider =
    record.readAloudProvider === "openai" ||
    record.readAloudProvider === "inworld"
      ? record.readAloudProvider
      : undefined;

  const result: RealtimeVoicePreferences = { provider };
  if (provider !== "stella" && model) result.model = model;
  if (voices) result.voices = voices;
  if (stellaSubProvider) result.stellaSubProvider = stellaSubProvider;
  if (inworldSpeed !== undefined) result.inworldSpeed = inworldSpeed;
  if (readAloudProvider) result.readAloudProvider = readAloudProvider;
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
