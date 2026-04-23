/**
 * Local preferences — reads/writes `desktop/state/preferences.json`.
 *
 * Serves as the local source of truth for user preferences that were
 * previously fetched from Convex on every chat turn. The runner syncs
 * these from Convex once on startup and writes to disk.
 */

import fs from "fs";
import path from "path";
import { ensurePrivateDirSync, writePrivateFileSync } from "../shared/private-fs.js";
import {
  DEFAULT_RADIAL_TRIGGER_CODE,
  normalizeRadialTriggerCode,
  type RadialTriggerCode,
} from "../../../desktop/src/shared/lib/radial-trigger.js";

type AgentEngine = "default" | "claude_code_local";

export type LocalPreferences = {
  /** Backend-owned default models keyed by agent type. */
  defaultModels: Record<string, string>;
  /** Current resolved upstream model behind each backend-owned default. */
  resolvedDefaultModels: Record<string, string>;
  /** Model overrides keyed by agent type, e.g. "orchestrator" -> "anthropic/claude-opus-4.6" */
  modelOverrides: Record<string, string>;
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
};

const DEFAULT_MAX_AGENT_CONCURRENCY = 24;

const DEFAULT_PREFERENCES: LocalPreferences = {
  defaultModels: {},
  resolvedDefaultModels: {},
  modelOverrides: {},
  expressionStyle: undefined,
  generalAgentEngine: "default",
  selfModAgentEngine: "default",
  maxAgentConcurrency: DEFAULT_MAX_AGENT_CONCURRENCY,
  syncMode: "off",
  radialTriggerKey: DEFAULT_RADIAL_TRIGGER_CODE,
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
      resolvedDefaultModels:
        parsed.resolvedDefaultModels ?? DEFAULT_PREFERENCES.resolvedDefaultModels,
      modelOverrides: parsed.modelOverrides ?? DEFAULT_PREFERENCES.modelOverrides,
      expressionStyle: parsed.expressionStyle,
      generalAgentEngine: normalizeEngine(parsed.generalAgentEngine),
      selfModAgentEngine: normalizeEngine(parsed.selfModAgentEngine),
      maxAgentConcurrency: normalizeConcurrency(parsed.maxAgentConcurrency),
      syncMode: parsed.syncMode === "on" ? "on" : "off",
      radialTriggerKey: normalizeRadialTriggerCode(parsed.radialTriggerKey),
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

export const getExpressionStyle = (
  stellaHome: string,
): string | undefined => {
  return loadLocalPreferences(stellaHome).expressionStyle;
};

export const getGeneralAgentEngine = (
  stellaHome: string,
): AgentEngine => {
  return loadLocalPreferences(stellaHome).generalAgentEngine;
};

export const getSelfModAgentEngine = (
  stellaHome: string,
): AgentEngine => {
  return loadLocalPreferences(stellaHome).selfModAgentEngine;
};

export const getMaxAgentConcurrency = (
  stellaHome: string,
): number => {
  return loadLocalPreferences(stellaHome).maxAgentConcurrency;
};

/**
 * Resolve the model name for the Explore agent. Prefers an explicit override
 * (modelOverrides["explore"]), then a backend-supplied default
 * (defaultModels["explore"]), then returns undefined to let resolveLlmRoute
 * fall back to STELLA_DEFAULT_MODEL.
 *
 * Explore is meant to be a fast cheap pass over state/. Users who want to
 * spend more should set modelOverrides["explore"] explicitly.
 */
export const getExploreModel = (
  stellaHome: string,
): string | undefined => {
  const prefs = loadLocalPreferences(stellaHome);
  return prefs.modelOverrides["explore"] ?? prefs.defaultModels["explore"];
};

export const getSyncMode = (
  stellaHome: string,
): "on" | "off" => {
  return loadLocalPreferences(stellaHome).syncMode;
};

// ── Normalization helpers ─────────────────────────────────────────────────

const normalizeEngine = (
  value: unknown,
): AgentEngine => {
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
