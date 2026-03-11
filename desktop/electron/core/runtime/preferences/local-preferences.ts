/**
 * Local preferences — reads/writes install-root `.stella/state/preferences.json`.
 *
 * Serves as the local source of truth for user preferences that were
 * previously fetched from Convex on every chat turn. The runner syncs
 * these from Convex once on startup and writes to disk.
 */

import fs from "fs";
import path from "path";
import { ensurePrivateDirSync, writePrivateFileSync } from "../../../system/private-fs.js";

export type LocalPreferences = {
  /** Backend-owned default models keyed by agent type. */
  defaultModels: Record<string, string>;
  /** Current resolved upstream model behind each backend-owned default. */
  resolvedDefaultModels: Record<string, string>;
  /** Model overrides keyed by agent type, e.g. "orchestrator" -> "anthropic/claude-opus-4.6" */
  modelOverrides: Record<string, string>;
  /** Expression style: "none" | "emoji" | undefined (default) */
  expressionStyle?: string;
  /** General agent engine: "default" | "codex_local" | "claude_code_local" */
  generalAgentEngine: "default" | "codex_local" | "claude_code_local";
  /** Max concurrency for Codex local engine */
  codexLocalMaxConcurrency: number;
  /** Sync mode: "on" | "off". Defaults to off so cloud persistence is opt-in. */
  syncMode: "on" | "off";
};

const DEFAULT_PREFERENCES: LocalPreferences = {
  defaultModels: {},
  resolvedDefaultModels: {},
  modelOverrides: {},
  expressionStyle: undefined,
  generalAgentEngine: "default",
  codexLocalMaxConcurrency: 3,
  syncMode: "off",
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
      defaultModels: parsed.defaultModels ?? {},
      resolvedDefaultModels: parsed.resolvedDefaultModels ?? {},
      modelOverrides: parsed.modelOverrides ?? {},
      expressionStyle: parsed.expressionStyle,
      generalAgentEngine: normalizeEngine(parsed.generalAgentEngine),
      codexLocalMaxConcurrency: normalizeConcurrency(parsed.codexLocalMaxConcurrency),
      syncMode: parsed.syncMode === "on" ? "on" : "off",
    };
    _cached = prefs;
    _cachedMtime = stat.mtimeMs;
    return prefs;
  } catch {
    return {
      ...DEFAULT_PREFERENCES,
      defaultModels: {},
      resolvedDefaultModels: {},
      modelOverrides: {},
    };
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
): "default" | "codex_local" | "claude_code_local" => {
  return loadLocalPreferences(stellaHome).generalAgentEngine;
};

export const getCodexLocalMaxConcurrency = (
  stellaHome: string,
): number => {
  return loadLocalPreferences(stellaHome).codexLocalMaxConcurrency;
};

export const getSyncMode = (
  stellaHome: string,
): "on" | "off" => {
  return loadLocalPreferences(stellaHome).syncMode;
};

// ── Normalization helpers ─────────────────────────────────────────────────

const normalizeEngine = (
  value: unknown,
): "default" | "codex_local" | "claude_code_local" => {
  if (value === "codex_local") return "codex_local";
  if (value === "claude_code_local") return "claude_code_local";
  return "default";
};

const normalizeConcurrency = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(3, Math.floor(parsed)));
};
