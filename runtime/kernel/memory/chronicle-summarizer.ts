/**
 * Chronicle rolling summary generator.
 *
 * Codex's Chronicle daemon does its own LLM-driven rolling summaries inside
 * the Rust process (10-min summary refreshed every minute, 6-hour summary
 * refreshed every hour). Stella keeps the Swift sidecar focused on capture +
 * raw OCR; this module is the Node-side equivalent of Codex's
 * `recursive_summarizer`.
 *
 * For each tick:
 *   1. Read the tail of `state/chronicle/captures.jsonl` for the window.
 *   2. Aggregate `addedLines` into a deduped, ordered list.
 *   3. If too few unique lines, no-op (no LLM call, no file write).
 *   4. Otherwise call a single LLM completion to distill the OCR window into
 *      a short markdown block.
 *   5. Atomically overwrite
 *      `state/memories_extensions/chronicle/{prefix}-current.md`.
 *
 * The Dream scheduler picks up the file's bumped mtime via the existing
 * `extension_files` watermark in `dream-core.ts`. Each tick that actually
 * writes a fresh summary should be paired with a `triggerDreamNow` call by
 * the caller, but Dream's eligibility gate is the source of truth.
 *
 * Single-flight per (stellaHome, window) via a mkdir lock under
 * `state/locks/chronicle-summary-{window}/`, mirroring `dream-scheduler.ts`.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type { Context, Message } from "../../ai/types.js";
import {
  getResolvedLlmApiKey,
  resolvedLlmSupportsCredentiallessCalls,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import { createRuntimeLogger } from "../debug.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";

const logger = createRuntimeLogger("memory.chronicle-summarizer");

export type ChronicleSummaryWindow = "10m" | "6h";

const WINDOW_MS: Record<ChronicleSummaryWindow, number> = {
  "10m": 10 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
};

const MIN_UNIQUE_LINES = 5;
const MAX_LINES_FED_TO_LLM = 400;
const MAX_FILE_SIZE_FOR_TAIL = 16 * 1024 * 1024; // 16MB; full read fallback above this

type CaptureEntry = {
  ts: string;
  displayId?: string;
  addedLines?: string[];
  removedLines?: string[];
};

type ChronicleConfig = {
  enabled?: boolean;
};

type StellaConfig = {
  chronicle?: ChronicleConfig;
};

const chronicleStateDir = (stellaHome: string): string =>
  path.join(stellaHome, "state", "chronicle");

const capturesPath = (stellaHome: string): string =>
  path.join(chronicleStateDir(stellaHome), "captures.jsonl");

const chronicleExtensionDir = (stellaHome: string): string =>
  path.join(stellaHome, "state", "memories_extensions", "chronicle");

const summaryFilePath = (
  stellaHome: string,
  window: ChronicleSummaryWindow,
): string =>
  path.join(chronicleExtensionDir(stellaHome), `${window}-current.md`);

const summaryMetaPath = (
  stellaHome: string,
  window: ChronicleSummaryWindow,
): string =>
  path.join(chronicleExtensionDir(stellaHome), `${window}-current.meta.json`);

const instructionsFilePath = (stellaHome: string): string =>
  path.join(chronicleExtensionDir(stellaHome), "instructions.md");

const INSTRUCTIONS_TEMPLATE = `# Chronicle extension

The Chronicle sidecar samples the user's screen every few seconds, runs Vision
OCR, and writes the *changes* (added/removed text lines) to
\`captures.jsonl\`. The Node-side summarizer then produces three views of that
data, all dropped in this folder:

- \`<DATE>.md\`         — daily append-only log of newly-observed OCR lines
                         (raw, written by the Swift daemon).
- \`10m-current.md\`     — distilled summary of the **last ~10 minutes** of
                         activity. Refreshed every minute by chronicle-summarizer.
- \`6h-current.md\`      — distilled summary of the **last ~6 hours** of
                         activity. Refreshed every hour.

For the Dream agent: prefer \`10m-current.md\` and \`6h-current.md\` — they are
already paraphrased and grouped. Use \`<DATE>.md\` only as raw evidence when
the rolling summaries leave a gap. Ignore single-line spikes in the raw log;
trust repeated patterns. Do NOT quote raw OCR text verbatim into MEMORY.md —
it's noisy. Distill into one or two sentences per material context shift.
`;

const ensureInstructions = async (stellaHome: string): Promise<void> => {
  const target = instructionsFilePath(stellaHome);
  try {
    const existing = await fsp.readFile(target, "utf-8");
    if (existing === INSTRUCTIONS_TEMPLATE) {
      return;
    }
  } catch {
    // missing or unreadable; fall through to write
  }
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, INSTRUCTIONS_TEMPLATE, "utf-8");
  } catch (error) {
    logger.debug("chronicle.instructions.write-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const isChronicleEnabled = async (stellaHome: string): Promise<boolean> => {
  try {
    const raw = await fsp.readFile(
      path.join(stellaHome, "state", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as StellaConfig;
    return parsed.chronicle?.enabled !== false;
  } catch {
    return true;
  }
};

const lockDir = (stellaHome: string, window: ChronicleSummaryWindow): string =>
  path.join(stellaHome, "state", "locks", `chronicle-summary-${window}`);

const acquireLock = (
  stellaHome: string,
  window: ChronicleSummaryWindow,
): (() => void) | null => {
  const dir = lockDir(stellaHome, window);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        window,
      }),
      "utf-8",
    );
    return () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      logger.debug("chronicle.lock.error", {
        window,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    try {
      const stat = fs.statSync(dir);
      if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
        fs.rmSync(dir, { recursive: true, force: true });
        return acquireLock(stellaHome, window);
      }
    } catch {
      // ignore
    }
    return null;
  }
};

const parseEntry = (line: string): CaptureEntry | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as CaptureEntry;
    if (typeof parsed.ts !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
};

const readCapturesInWindow = async (
  stellaHome: string,
  windowMs: number,
): Promise<CaptureEntry[]> => {
  const file = capturesPath(stellaHome);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  if (stat.size === 0) return [];

  const cutoffMs = Date.now() - windowMs;

  let raw: string;
  try {
    if (stat.size <= MAX_FILE_SIZE_FOR_TAIL) {
      raw = await fsp.readFile(file, "utf-8");
    } else {
      // Tail read: open and read the trailing chunk so giant capture files
      // don't OOM the worker. ~2MB is enough for many minutes of OCR deltas.
      const handle = await fsp.open(file, "r");
      try {
        const tailBytes = 2 * 1024 * 1024;
        const start = Math.max(0, stat.size - tailBytes);
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        raw = buffer.toString("utf-8");
        // Drop a likely-partial first line.
        const firstNewline = raw.indexOf("\n");
        if (firstNewline > 0) {
          raw = raw.slice(firstNewline + 1);
        }
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    logger.debug("chronicle.captures.read-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const lines = raw.split("\n");
  const entries: CaptureEntry[] = [];
  for (const line of lines) {
    const entry = parseEntry(line);
    if (!entry) continue;
    const tsMs = Date.parse(entry.ts);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < cutoffMs) continue;
    entries.push(entry);
  }
  return entries;
};

const aggregateUniqueLines = (entries: CaptureEntry[]): string[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of entries) {
    for (const line of entry.addedLines ?? []) {
      const norm = line.trim();
      if (norm.length < 3) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      ordered.push(norm);
      if (ordered.length >= MAX_LINES_FED_TO_LLM) {
        return ordered;
      }
    }
  }
  return ordered;
};

const buildInputFingerprint = (
  window: ChronicleSummaryWindow,
  lines: string[],
): string =>
  createHash("sha256")
    .update(window)
    .update("\0")
    .update(lines.join("\n"))
    .digest("hex");

const readExistingInputFingerprint = async (
  stellaHome: string,
  window: ChronicleSummaryWindow,
): Promise<string | null> => {
  try {
    const raw = await fsp.readFile(summaryMetaPath(stellaHome, window), "utf-8");
    const parsed = JSON.parse(raw) as { inputFingerprint?: unknown };
    return typeof parsed.inputFingerprint === "string"
      ? parsed.inputFingerprint
      : null;
  } catch {
    return null;
  }
};

const buildSystemPrompt = (window: ChronicleSummaryWindow): string => {
  const horizon =
    window === "10m"
      ? "the last ~10 minutes"
      : "the last ~6 hours";
  return [
    "You are Chronicle's recursive summarizer for Stella.",
    `You receive deduped on-screen text lines that the OCR sampler observed across ${horizon} of screen activity.`,
    "Distill them into a short markdown block describing what the user was actively doing.",
    "",
    "Rules:",
    "  - Do not quote raw OCR lines verbatim. Paraphrase and group.",
    "  - Identify the dominant app(s)/contexts and any notable transitions.",
    "  - Skip OS chrome, generic UI strings, and stale fragments.",
    "  - 5-12 lines max. Use bullet points. No preamble. No closing remarks.",
    "  - If the lines look meaningless, irrelevant, or insufficient signal, respond exactly with: NO_SIGNAL",
  ].join("\n");
};

const buildUserPrompt = (
  window: ChronicleSummaryWindow,
  lines: string[],
): string => {
  const horizon = window === "10m" ? "10-minute" : "6-hour";
  return [
    `On-screen text lines observed in the last ${horizon} window:`,
    "",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
};

const renderSummaryFile = (
  window: ChronicleSummaryWindow,
  body: string,
  uniqueLineCount: number,
): string => {
  const horizon = window === "10m" ? "10 minutes" : "6 hours";
  const generatedAt = new Date().toISOString();
  return [
    `# Chronicle ${window} summary`,
    "",
    `> Distilled by the chronicle-summarizer at ${generatedAt}.`,
    `> Window: last ${horizon}. Source: ${uniqueLineCount} unique OCR lines.`,
    `> Consumed by the Dream agent (see ./instructions.md).`,
    "",
    body.trim(),
    "",
  ].join("\n");
};

const writeFileAtomic = async (
  filePath: string,
  contents: string,
): Promise<void> => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, contents, "utf-8");
  await fsp.rename(tmp, filePath);
};

export type ChronicleSummaryResult =
  | { wrote: true; window: ChronicleSummaryWindow; uniqueLines: number; outPath: string }
  | {
      wrote: false;
      window: ChronicleSummaryWindow;
      reason:
        | "disabled"
        | "lock_busy"
        | "no_api_key"
        | "no_captures"
        | "below_threshold"
        | "unchanged"
        | "no_signal"
        | "llm_failed"
        | "write_failed";
      uniqueLines: number;
      detail?: string;
    };

export const runChronicleSummary = async (args: {
  stellaHome: string;
  window: ChronicleSummaryWindow;
  resolvedLlm: ResolvedLlmRoute;
}): Promise<ChronicleSummaryResult> => {
  if (!(await isChronicleEnabled(args.stellaHome))) {
    return {
      wrote: false,
      window: args.window,
      reason: "disabled",
      uniqueLines: 0,
    };
  }

  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: args.stellaHome,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : await getResolvedLlmApiKey(args.resolvedLlm);
  if (
    !useClaudeCode &&
    !apiKey &&
    !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)
  ) {
    return {
      wrote: false,
      window: args.window,
      reason: "no_api_key",
      uniqueLines: 0,
    };
  }

  const release = acquireLock(args.stellaHome, args.window);
  if (!release) {
    return {
      wrote: false,
      window: args.window,
      reason: "lock_busy",
      uniqueLines: 0,
    };
  }

  try {
    await ensureInstructions(args.stellaHome);

    const entries = await readCapturesInWindow(
      args.stellaHome,
      WINDOW_MS[args.window],
    );
    if (entries.length === 0) {
      return {
        wrote: false,
        window: args.window,
        reason: "no_captures",
        uniqueLines: 0,
      };
    }

    const uniqueLines = aggregateUniqueLines(entries);
    if (uniqueLines.length < MIN_UNIQUE_LINES) {
      return {
        wrote: false,
        window: args.window,
        reason: "below_threshold",
        uniqueLines: uniqueLines.length,
      };
    }

    const inputFingerprint = buildInputFingerprint(args.window, uniqueLines);
    const existingFingerprint = await readExistingInputFingerprint(
      args.stellaHome,
      args.window,
    );
    if (existingFingerprint === inputFingerprint) {
      return {
        wrote: false,
        window: args.window,
        reason: "unchanged",
        uniqueLines: uniqueLines.length,
      };
    }

    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildUserPrompt(args.window, uniqueLines),
          },
        ],
        timestamp: Date.now(),
      },
    ];
    const context: Context = {
      systemPrompt: buildSystemPrompt(args.window),
      messages,
      tools: [],
    };

    let responseText: string;
    try {
      if (useClaudeCode) {
        responseText = (
          await runClaudeCodeAgentTextCompletion({
            stellaRoot: args.stellaHome,
            agentType: AGENT_IDS.CHRONICLE,
            context,
          })
        ).trim();
      } else {
        const response = await completeSimple(
          args.resolvedLlm.model,
          context,
          apiKey ? { apiKey } : undefined,
        );
        responseText = readAssistantText(response).trim();
      }
    } catch (error) {
      logger.debug("chronicle.summary.llm-failed", {
        window: args.window,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        wrote: false,
        window: args.window,
        reason: "llm_failed",
        uniqueLines: uniqueLines.length,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (!responseText || /^NO_SIGNAL\b/i.test(responseText)) {
      return {
        wrote: false,
        window: args.window,
        reason: "no_signal",
        uniqueLines: uniqueLines.length,
      };
    }

    const outPath = summaryFilePath(args.stellaHome, args.window);
    const rendered = renderSummaryFile(
      args.window,
      responseText,
      uniqueLines.length,
    );
    try {
      await writeFileAtomic(outPath, rendered);
    } catch (error) {
      logger.debug("chronicle.summary.write-failed", {
        window: args.window,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        wrote: false,
        window: args.window,
        reason: "write_failed",
        uniqueLines: uniqueLines.length,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await writeFileAtomic(
        summaryMetaPath(args.stellaHome, args.window),
        `${JSON.stringify(
          {
            window: args.window,
            inputFingerprint,
            uniqueLines: uniqueLines.length,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      logger.debug("chronicle.summary.meta-write-failed", {
        window: args.window,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.debug("chronicle.summary.wrote", {
      window: args.window,
      outPath,
      uniqueLines: uniqueLines.length,
    });
    return {
      wrote: true,
      window: args.window,
      uniqueLines: uniqueLines.length,
      outPath,
    };
  } finally {
    release();
  }
};

export const chronicleSummaryFilePath = summaryFilePath;
