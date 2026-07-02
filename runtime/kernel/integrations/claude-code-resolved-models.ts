/**
 * Claude Code resolved-model capture.
 *
 * The Claude Code CLI accepts aliases like `default`, `sonnet`, or `opus`
 * and reports the model it actually resolved to in the `system`/`init`
 * event on stdout (e.g. `"model": "claude-opus-4-8[1m]"`). We persist that
 * mapping (requested alias -> resolved model id) to a small JSON file in
 * the Stella data dir so the desktop process can show the real model name
 * next to "Default" in pickers instead of an opaque alias.
 *
 * The session runtime (which may run in a separate worker process) writes
 * this file; the desktop main process reads it when listing Claude Code
 * models. Both sides tolerate a missing or corrupt file.
 */

import fs from "fs";
import path from "path";
import { writePrivateFileSync } from "../shared/private-fs.js";

const RESOLVED_MODELS_FILE = "claude-code-resolved-models.json";

const resolvedModelsPath = (stellaAppDir: string): string =>
  path.join(stellaAppDir, RESOLVED_MODELS_FILE);

export const readClaudeCodeResolvedModels = (
  stellaAppDir: string,
): Record<string, string> => {
  try {
    const raw = fs.readFileSync(resolvedModelsPath(stellaAppDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<string, string> = {};
    for (const [requested, resolved] of Object.entries(parsed)) {
      if (typeof resolved === "string" && resolved.trim()) {
        next[requested] = resolved.trim();
      }
    }
    return next;
  } catch {
    return {};
  }
};

export const recordClaudeCodeResolvedModel = (
  stellaAppDir: string,
  requestedModel: string,
  resolvedModel: string,
): void => {
  const requested = requestedModel.trim() || "default";
  const resolved = resolvedModel.trim();
  if (!resolved) return;
  try {
    const current = readClaudeCodeResolvedModels(stellaAppDir);
    if (current[requested] === resolved) return;
    writePrivateFileSync(
      resolvedModelsPath(stellaAppDir),
      JSON.stringify({ ...current, [requested]: resolved }, null, 2),
    );
  } catch {
    // Resolved-model capture is best-effort; never fail a turn over it.
  }
};

/**
 * Pretty-print a raw Anthropic model id reported by the CLI, e.g.
 * `claude-opus-4-8[1m]` -> `Opus 4.8 (1M context)` or
 * `claude-sonnet-4-5-20250929` -> `Sonnet 4.5`. Unknown shapes pass through.
 */
export const formatClaudeCodeResolvedModel = (modelId: string): string => {
  const trimmed = modelId.trim();
  const oneMillion = trimmed.endsWith("[1m]");
  const bare = oneMillion ? trimmed.slice(0, -"[1m]".length) : trimmed;
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(bare);
  if (!match) return trimmed;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  const label = `${family} ${version}`;
  return oneMillion ? `${label} (1M context)` : label;
};
