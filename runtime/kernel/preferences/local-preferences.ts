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
} from "../../../desktop/src/shared/lib/radial-trigger.js";
import {
  DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  normalizeMiniDoubleTapModifier,
  type MiniDoubleTapModifier,
} from "../../../desktop/src/shared/lib/mini-double-tap.js";

type AgentEngine = "default" | "claude_code_local";

export type LocalPreferences = {
  /** Default models keyed by agent type. */
  defaultModels: Record<string, string>;
  /** Model overrides keyed by agent type, e.g. "orchestrator" -> "anthropic/claude-opus-4.6" */
  modelOverrides: Record<string, string>;
  /** Whether runtime LLM calls may use locally saved user API keys. */
  localLlmKeysEnabled: boolean;
  /** Active local provider when local API keys are enabled. */
  localLlmProvider: string;
  /** Expression style: "none" | "emoji" | undefined (default) */
  expressionStyle?: string;
  /** General agent engine: "default" | "claude_code_local" */
  generalAgentEngine: AgentEngine;
  /** Self-mod agent engine: "default" | "claude_code_local" */
  selfModAgentEngine: AgentEngine;
  /** Shared max concurrency across all agent task execution */
  maxAgentConcurrency: number;
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
};

export type LocalModelPreferencesSnapshot = Pick<
  LocalPreferences,
  | "defaultModels"
  | "modelOverrides"
  | "generalAgentEngine"
  | "selfModAgentEngine"
  | "maxAgentConcurrency"
>;

const DEFAULT_MAX_AGENT_CONCURRENCY = 24;

const DEFAULT_PREFERENCES: LocalPreferences = {
  defaultModels: {},
  modelOverrides: {},
  localLlmKeysEnabled: false,
  localLlmProvider: "openai",
  expressionStyle: undefined,
  generalAgentEngine: "default",
  selfModAgentEngine: "default",
  maxAgentConcurrency: DEFAULT_MAX_AGENT_CONCURRENCY,
  syncMode: "off",
  radialTriggerKey: DEFAULT_RADIAL_TRIGGER_CODE,
  dictationShortcut: "Alt",
  voiceRtcShortcut: "CommandOrControl+Shift+D",
  miniDoubleTapModifier: DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  preventComputerSleep: false,
  soundNotificationsEnabled: true,
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
      localLlmKeysEnabled: parsed.localLlmKeysEnabled === true,
      localLlmProvider:
        typeof parsed.localLlmProvider === "string" &&
        parsed.localLlmProvider.trim()
          ? parsed.localLlmProvider.trim().toLowerCase()
          : DEFAULT_PREFERENCES.localLlmProvider,
      expressionStyle: parsed.expressionStyle,
      generalAgentEngine: normalizeEngine(parsed.generalAgentEngine),
      selfModAgentEngine: normalizeEngine(parsed.selfModAgentEngine),
      maxAgentConcurrency: normalizeConcurrency(parsed.maxAgentConcurrency),
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

export const getLocalLlmProviderPreference = (
  stellaHome: string,
): { enabled: boolean; provider: string } => {
  const prefs = loadLocalPreferences(stellaHome);
  return {
    enabled: prefs.localLlmKeysEnabled,
    provider: prefs.localLlmProvider,
  };
};

export const getExpressionStyle = (stellaHome: string): string | undefined => {
  return loadLocalPreferences(stellaHome).expressionStyle;
};

export const getGeneralAgentEngine = (stellaHome: string): AgentEngine => {
  return loadLocalPreferences(stellaHome).generalAgentEngine;
};

export const getSelfModAgentEngine = (stellaHome: string): AgentEngine => {
  return loadLocalPreferences(stellaHome).selfModAgentEngine;
};

export const getMaxAgentConcurrency = (stellaHome: string): number => {
  return loadLocalPreferences(stellaHome).maxAgentConcurrency;
};

export const getLocalModelPreferences = (
  stellaHome: string,
): LocalModelPreferencesSnapshot => {
  const prefs = loadLocalPreferences(stellaHome);
  return {
    defaultModels: { ...prefs.defaultModels },
    modelOverrides: { ...prefs.modelOverrides },
    generalAgentEngine: prefs.generalAgentEngine,
    selfModAgentEngine: prefs.selfModAgentEngine,
    maxAgentConcurrency: prefs.maxAgentConcurrency,
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
    generalAgentEngine:
      patch.generalAgentEngine === undefined
        ? prefs.generalAgentEngine
        : normalizeEngine(patch.generalAgentEngine),
    selfModAgentEngine:
      patch.selfModAgentEngine === undefined
        ? prefs.selfModAgentEngine
        : normalizeEngine(patch.selfModAgentEngine),
    maxAgentConcurrency:
      patch.maxAgentConcurrency === undefined
        ? prefs.maxAgentConcurrency
        : normalizeConcurrency(patch.maxAgentConcurrency),
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

// ── Normalization helpers ─────────────────────────────────────────────────

const normalizeEngine = (value: unknown): AgentEngine => {
  if (value === "claude_code_local") return "claude_code_local";
  return "default";
};

const normalizeConcurrency = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_AGENT_CONCURRENCY;
  }
  const rounded = Math.floor(parsed);
  return Math.min(DEFAULT_MAX_AGENT_CONCURRENCY, rounded);
};
