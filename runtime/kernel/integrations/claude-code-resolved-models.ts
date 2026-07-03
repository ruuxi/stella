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
 * models. Writes are serialized per file through an in-process mutex and
 * land via temp-file + rename, so concurrent sessions can't interleave
 * read-modify-write cycles and a crash mid-write never leaves partial
 * JSON behind. Both sides tolerate a missing or corrupt file.
 */

import crypto from "crypto";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import { writePrivateFile } from "../shared/private-fs.js";

const RESOLVED_MODELS_FILE = "claude-code-resolved-models.json";

/**
 * Model aliases the `claude` CLI accepts via `--model`
 * (https://code.claude.com/docs/en/model-config). Canonical list — the
 * session runtime derives its picker options from it, and stored keys
 * outside this set (full model ids) are bounded by a small LRU below.
 */
export const CLAUDE_CODE_MODEL_ALIASES = [
  "default",
  "best",
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "opusplan",
  "sonnet[1m]",
  "opus[1m]",
] as const;

const ALIAS_KEYS: ReadonlySet<string> = new Set(CLAUDE_CODE_MODEL_ALIASES);

/** Non-alias keys (full model ids) kept, newest-first, before eviction. */
const MAX_NON_ALIAS_KEYS = 8;

const resolvedModelsPath = (stellaAppDir: string): string =>
  path.join(stellaAppDir, RESOLVED_MODELS_FILE);

/**
 * Per-file write queue. Chaining every record onto the previous one makes
 * the read-modify-write cycle atomic within this process even though the
 * file IO is async.
 */
const writeQueues = new Map<string, Promise<void>>();

const withFileQueue = (
  filePath: string,
  task: () => Promise<void>,
): Promise<void> => {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(filePath, next);
  void next.finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  });
  return next;
};

const writeFileAtomic = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const tmpPath = `${filePath}.${process.pid}.${crypto
    .randomBytes(4)
    .toString("hex")}.tmp`;
  try {
    await writePrivateFile(tmpPath, content);
    await fsPromises.rename(tmpPath, filePath);
  } catch (error) {
    await fsPromises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

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

/**
 * Persist a requested -> resolved mapping. Best-effort: failures are
 * swallowed (never fail a turn over display metadata), but the returned
 * promise resolves only after the write settles so tests can await it.
 */
export const recordClaudeCodeResolvedModel = (
  stellaAppDir: string,
  requestedModel: string,
  resolvedModel: string,
): Promise<void> => {
  const requested = requestedModel.trim() || "default";
  const resolved = resolvedModel.trim();
  if (!resolved) return Promise.resolve();
  const filePath = resolvedModelsPath(stellaAppDir);
  return withFileQueue(filePath, async () => {
    try {
      const current = readClaudeCodeResolvedModels(stellaAppDir);
      if (current[requested] === resolved) return;
      // Re-insert the key so object order doubles as recency order for
      // the non-alias LRU below.
      delete current[requested];
      const entries = [...Object.entries(current), [requested, resolved]];
      const aliasEntries = entries.filter(([key]) => ALIAS_KEYS.has(key));
      const nonAliasEntries = entries.filter(([key]) => !ALIAS_KEYS.has(key));
      const bounded = [
        ...aliasEntries,
        ...nonAliasEntries.slice(-MAX_NON_ALIAS_KEYS),
      ];
      await writeFileAtomic(
        filePath,
        JSON.stringify(Object.fromEntries(bounded), null, 2),
      );
    } catch {
      // Resolved-model capture is best-effort; never fail a turn over it.
    }
  });
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
