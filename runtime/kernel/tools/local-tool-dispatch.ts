import { promises as fs } from "node:fs";
import path from "node:path";

import { TOOL_IDS } from "../../contracts/agent-runtime.js";
import {
  MEMORY_INDEX_FILE,
  MEMORY_MAP_FILE,
  MEMORY_MAP_DERIVED_END_ANCHOR,
  MEMORY_MAP_DERIVED_START_ANCHOR,
  MEMORY_MAP_MAX_CHARS,
  MEMORY_MAP_ROUTES_END_ANCHOR,
  MEMORY_MAP_ROUTES_START_ANCHOR,
  MEMORY_SHADOW_FILE,
  MEMORY_SUMMARY_FILE,
  memoryFilePath,
  memoryIndexPath,
  memoryMapPath,
  memoryShadowPath,
  memorySummaryPath,
  stripInjectedHtmlComments,
} from "../memory/dream-storage.js";
import {
  appendSupersededMemoryText,
  memoryArchiveRoot,
} from "../memory/memory-rotation.js";
import { redactMemoryText } from "../memory/redaction.js";
import type {
  DreamInboxKind,
  DreamInboxStore,
} from "../memory/dream-inbox-store.js";
import { localNoResponse } from "./local-tool-overrides.js";
import { withFileWriteLock, writeFileWithNulGuard } from "./file-write-lock.js";

export type LocalToolStore = {
  dreamInboxStore?: DreamInboxStore;
};

export type LocalDreamConfig = {
  stellaDataDir: string;
  /**
   * When set, Dream's `list` hides rows the pass's orchestrator delta
   * already represents (the delta's own conversation, covered kinds, newer
   * than the watermark the delta derives from), so the model is not
   * double-fed. Rows from OTHER conversations, legacy NULL-conversation
   * rows, pre-window rows, and chronicle transport still list normally —
   * they flow through the model-driven markProcessed path exactly like the
   * pre-migration inbox pass, which is what keeps at-least-once intact.
   */
  inboxListExclude?: {
    conversationId: string;
    kinds: readonly DreamInboxKind[];
    /** Exclusive lower bound of the pass's delta window. */
    sinceTs: number;
  };
};

const isWithinDirectory = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const normalizePath = async (target: string): Promise<string> => {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
};

const resolveDreamToolPath = async (
  dream: LocalDreamConfig,
  filePath: string,
): Promise<string> => {
  const candidate = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(dream.stellaDataDir, filePath);
  return await normalizePath(candidate);
};

const ensureDreamReadPath = async (
  dream: LocalDreamConfig,
  filePath: string,
): Promise<string> => {
  const resolved = await resolveDreamToolPath(dream, filePath);
  // The shadow-validation log records UNVALIDATED delta-derivation
  // proposals; letting Dream read it would feed the path being validated
  // back into the live derivation it is compared against.
  if (resolved === (await normalizePath(memoryShadowPath(dream.stellaDataDir)))) {
    throw new Error(
      `${MEMORY_SHADOW_FILE} is the shadow-validation log and is not readable by Dream; it is diagnostic output, not memory.`,
    );
  }
  const [memoriesRoot, extensionsRoot] = await Promise.all([
    normalizePath(path.join(dream.stellaDataDir, "memories")),
    normalizePath(path.join(dream.stellaDataDir, "memories_extensions")),
  ]);
  if (
    isWithinDirectory(resolved, memoriesRoot) ||
    isWithinDirectory(resolved, extensionsRoot)
  ) {
    return resolved;
  }
  throw new Error(
    "Dream Read may only access files under ~/.stella/memories and ~/.stella/memories_extensions.",
  );
};

const MEMORY_FILE_LABELS = `MEMORY.md and ${MEMORY_MAP_FILE}`;

const ensureDreamWritePath = async (
  dream: LocalDreamConfig,
  filePath: string,
): Promise<string> => {
  const resolved = await resolveDreamToolPath(dream, filePath);
  const allowedFiles = await Promise.all([
    normalizePath(memoryFilePath(dream.stellaDataDir)),
    normalizePath(memoryMapPath(dream.stellaDataDir)),
  ]);
  if (allowedFiles.includes(resolved)) {
    return resolved;
  }
  const retiredFiles = await Promise.all([
    normalizePath(memorySummaryPath(dream.stellaDataDir)),
    normalizePath(memoryIndexPath(dream.stellaDataDir)),
  ]);
  if (retiredFiles.includes(resolved)) {
    throw new Error(
      `${MEMORY_SUMMARY_FILE} and ${MEMORY_INDEX_FILE} are retired and read-only; their role moved to ${MEMORY_MAP_FILE}. Edit ${MEMORY_MAP_FILE} instead.`,
    );
  }
  if (
    isWithinDirectory(
      resolved,
      await normalizePath(memoryArchiveRoot(dream.stellaDataDir)),
    )
  ) {
    throw new Error(
      "Files under memories/archive are rotation and supersede-preservation output and are read-only. Edit MEMORY.md instead — text your edits remove is preserved there automatically.",
    );
  }
  throw new Error(
    `Dream StrReplace may only edit ${MEMORY_FILE_LABELS}.`,
  );
};

/**
 * Mechanical guard on `memory_map.md` writes (CC v2.1.210-style): a write
 * that would push the INJECTED view (HTML comments stripped — charter and
 * anchors are free) past the hard cap, blank it, or destroy the routing
 * anchors is rejected with an explanatory error so Dream curates instead of
 * a silent truncation ever hiding entries. Returns an error string, or null
 * when the candidate content is acceptable.
 */
export const validateMemoryMapWrite = (updated: string): string | null => {
  const injected = stripInjectedHtmlComments(updated);
  if (injected.length > MEMORY_MAP_MAX_CHARS) {
    return `Write rejected: ${MEMORY_MAP_FILE} would inject ${injected.length} characters (hard cap ${MEMORY_MAP_MAX_CHARS}). Curate the map — merge related entries, prune stale ones, tighten wording — instead of exceeding the budget. Nothing was written.`;
  }
  if (injected.length === 0) {
    return `Write rejected: ${MEMORY_MAP_FILE} would have no injectable content (everything inside HTML comments). Keep at least the routing entries visible. Nothing was written.`;
  }
  // Ordering matters, not just presence: an END swapped before its START
  // would leave a section no follow-up StrReplace can address correctly.
  const routesStart = updated.indexOf(MEMORY_MAP_ROUTES_START_ANCHOR);
  const routesEnd = updated.indexOf(MEMORY_MAP_ROUTES_END_ANCHOR);
  if (routesStart === -1 || routesEnd === -1 || routesEnd < routesStart) {
    return `Write rejected: the ${MEMORY_MAP_ROUTES_START_ANCHOR} / ${MEMORY_MAP_ROUTES_END_ANCHOR} anchors must stay intact and in that order in ${MEMORY_MAP_FILE}. Edit between them. Nothing was written.`;
  }
  // The derived-constraints staging section is load-bearing (design review
  // §6.3: a detected constraint is never non-resident), so its anchors get
  // the same mechanical protection as the routing anchors. Every seeded map
  // contains both pairs; a file that lost them is repaired by a write that
  // restores them, which this guard accepts.
  const derivedStart = updated.indexOf(MEMORY_MAP_DERIVED_START_ANCHOR);
  const derivedEnd = updated.indexOf(MEMORY_MAP_DERIVED_END_ANCHOR);
  if (derivedStart === -1 || derivedEnd === -1 || derivedEnd < derivedStart) {
    return `Write rejected: the ${MEMORY_MAP_DERIVED_START_ANCHOR} / ${MEMORY_MAP_DERIVED_END_ANCHOR} anchors must stay intact and in that order in ${MEMORY_MAP_FILE} (restore them under "## Derived constraints" if they are missing). Nothing was written.`;
  }
  return null;
};

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "number" && Number.isFinite(entry));

export type LocalToolDeps = {
  conversationId: string;
  store?: LocalToolStore | null;
  dream?: LocalDreamConfig;
  signal?: AbortSignal;
};

type DispatchResult = { handled: true; text: string } | { handled: false };

/**
 * Dispatch tools that execute locally (no backend round-trip).
 * Shared between the agent tool-adapter pipeline and the voice service.
 */
export async function dispatchLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  deps: LocalToolDeps,
): Promise<DispatchResult> {
  if (toolName === TOOL_IDS.NO_RESPONSE) {
    const text = await localNoResponse();
    return { handled: true, text };
  }

  if (toolName === TOOL_IDS.READ) {
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    if (!filePath) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "file_path is required.",
        }),
      };
    }
    try {
      const resolvedPath = deps.dream
        ? await ensureDreamReadPath(deps.dream, filePath)
        : filePath;
      const rawContent = await fs.readFile(resolvedPath, "utf-8");
      const content = deps.dream ? redactMemoryText(rawContent) : rawContent;
      const offset =
        typeof args.offset === "number" && args.offset > 0 ? args.offset : 1;
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? args.limit : 2000;
      const lines = content.split("\n");
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice
        .map((line, idx) => `${String(offset + idx).padStart(6, " ")}|${line}`)
        .join("\n");
      return {
        handled: true,
        text: JSON.stringify({
          success: true,
          path: resolvedPath,
          totalLines: lines.length,
          content: numbered,
        }),
      };
    } catch (error) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }

  if (toolName === TOOL_IDS.STR_REPLACE) {
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    const oldString =
      typeof args.old_string === "string" ? args.old_string : "";
    const newString =
      typeof args.new_string === "string"
        ? deps.dream
          ? redactMemoryText(args.new_string)
          : args.new_string
        : "";
    const replaceAll = args.replace_all === true;
    if (!filePath) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "file_path is required.",
        }),
      };
    }
    try {
      const resolvedPath = deps.dream
        ? await ensureDreamWritePath(deps.dream, filePath)
        : filePath;
      // Same per-path lock as Edit/Write: the read-modify-write cycle must
      // not interleave with sibling edits of the same file.
      return await withFileWriteLock(resolvedPath, async () => {
        const original = await fs.readFile(resolvedPath, "utf-8");
        if (!original.includes(oldString)) {
          return {
            handled: true,
            text: JSON.stringify({
              success: false,
              error: "old_string not found in file.",
            }),
          };
        }
        let updated: string;
        let count: number;
        if (replaceAll) {
          const parts = original.split(oldString);
          count = parts.length - 1;
          updated = parts.join(newString);
        } else {
          const occurrences = original.split(oldString).length - 1;
          if (occurrences > 1) {
            return {
              handled: true,
              text: JSON.stringify({
                success: false,
                error: `old_string appears ${occurrences} times; pass replace_all=true or extend the anchor for uniqueness.`,
              }),
            };
          }
          const idx = original.indexOf(oldString);
          updated =
            original.slice(0, idx) +
            newString +
            original.slice(idx + oldString.length);
          count = 1;
        }
        // Hard budget on the resident routing map: over-cap or structure-
        // breaking writes error out here, BEFORE anything reaches disk, so
        // the doc is curated by the writer rather than truncated by a cap.
        if (
          deps.dream &&
          resolvedPath ===
            (await normalizePath(memoryMapPath(deps.dream.stellaDataDir)))
        ) {
          const rejection = validateMemoryMapWrite(updated);
          if (rejection) {
            return {
              handled: true,
              text: JSON.stringify({ success: false, error: rejection }),
            };
          }
        }
        // Supersede preservation on the durable ledger: an edit that removes
        // text from MEMORY.md (the replaced span no longer appears in the
        // updated content — pure insertions keep their anchor and skip this)
        // journals the removed text to the superseded archive FIRST. If the
        // journal cannot be written, the edit is rejected: no destructive
        // write lands without its preserved, Recall-reachable copy.
        if (
          deps.dream &&
          resolvedPath ===
            (await normalizePath(memoryFilePath(deps.dream.stellaDataDir))) &&
          oldString.trim() &&
          !updated.includes(oldString)
        ) {
          try {
            await appendSupersededMemoryText(deps.dream.stellaDataDir, oldString);
          } catch (error) {
            return {
              handled: true,
              text: JSON.stringify({
                success: false,
                error: `Write rejected: the removed text could not be preserved in the superseded archive (${
                  error instanceof Error ? error.message : String(error)
                }). Nothing was written.`,
              }),
            };
          }
        }
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await writeFileWithNulGuard(resolvedPath, updated);
        return {
          handled: true,
          text: JSON.stringify({
            success: true,
            path: resolvedPath,
            replacements: count,
          }),
        };
      });
    } catch (error) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }

  if (toolName === TOOL_IDS.DREAM) {
    const dream = deps.dream;
    const inbox = deps.store?.dreamInboxStore;
    if (!dream || !inbox) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "Dream tool not available in this context.",
        }),
      };
    }
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "list") {
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const rows = inbox.listUnprocessed({
        ...(limit !== undefined ? { limit } : {}),
        ...(dream.inboxListExclude
          ? { excludeConversationKinds: dream.inboxListExclude }
          : {}),
      });
      return {
        handled: true,
        text: JSON.stringify({
          success: true,
          items: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            ...(row.threadId ? { threadId: row.threadId } : {}),
            ...(row.runId ? { runId: row.runId } : {}),
            ...(row.agentType ? { agentType: row.agentType } : {}),
            ...(row.title ? { title: row.title } : {}),
            content: redactMemoryText(row.content),
            ...(row.metadata ? { metadata: row.metadata } : {}),
            sourceUpdatedAt: row.sourceUpdatedAt,
          })),
        }),
      };
    }
    if (action === "markProcessed") {
      if (!isNumberArray(args.ids) || args.ids.length === 0) {
        return {
          handled: true,
          text: JSON.stringify({
            success: false,
            error: "markProcessed requires a non-empty ids array.",
          }),
        };
      }
      const result = inbox.markProcessed({ ids: args.ids });
      return {
        handled: true,
        text: JSON.stringify({ success: true, ...result }),
      };
    }
    return {
      handled: true,
      text: JSON.stringify({
        success: false,
        error: "action must be 'list' or 'markProcessed'.",
      }),
    };
  }

  return { handled: false };
}
