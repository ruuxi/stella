import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStellaStatePath } from "../home/stella-home.js";

import { TOOL_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import { dreamList, dreamMarkProcessed } from "../memory/dream-core.js";
import type { MemoryStore, MemoryTarget } from "../memory/memory-store.js";
import {
  memoryFilePath,
  memorySummaryPath,
  rawMemoriesPath,
} from "../memory/dream-storage.js";
import type { ThreadSummariesStore } from "../memory/thread-summaries-store.js";
import { localNoResponse } from "./local-tool-overrides.js";

export type LocalToolStore = {
  memoryStore: MemoryStore;
  threadSummariesStore?: ThreadSummariesStore;
};

export type LocalDreamConfig = {
  stellaHome: string;
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
    : path.resolve(dream.stellaHome, filePath);
  return await normalizePath(candidate);
};

const ensureDreamReadPath = async (
  dream: LocalDreamConfig,
  filePath: string,
): Promise<string> => {
  const resolved = await resolveDreamToolPath(dream, filePath);
  const [memoriesRoot, extensionsRoot] = await Promise.all([
    normalizePath(path.join(resolveStellaStatePath(dream.stellaHome), "memories")),
    normalizePath(path.join(resolveStellaStatePath(dream.stellaHome), "memories_extensions")),
  ]);
  if (
    isWithinDirectory(resolved, memoriesRoot) ||
    isWithinDirectory(resolved, extensionsRoot)
  ) {
    return resolved;
  }
  throw new Error(
    "Dream Read may only access files under state/memories and state/memories_extensions.",
  );
};

const ensureDreamWritePath = async (
  dream: LocalDreamConfig,
  filePath: string,
): Promise<string> => {
  const resolved = await resolveDreamToolPath(dream, filePath);
  const allowedFiles = await Promise.all([
    normalizePath(memoryFilePath(dream.stellaHome)),
    normalizePath(memorySummaryPath(dream.stellaHome)),
    normalizePath(rawMemoriesPath(dream.stellaHome)),
  ]);
  if (allowedFiles.includes(resolved)) {
    return resolved;
  }
  throw new Error(
    "Dream StrReplace may only edit MEMORY.md, memory_summary.md, and raw_memories.md.",
  );
};

const isThreadKeyArray = (
  value: unknown,
): value is Array<{ threadId: string; runId: string }> =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      typeof (entry as { threadId?: unknown }).threadId === "string" &&
      typeof (entry as { runId?: unknown }).runId === "string",
  );

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isMemoryTarget = (value: unknown): value is MemoryTarget =>
  value === "memory" || value === "user";

const isMemoryAction = (
  value: unknown,
): value is "add" | "replace" | "remove" =>
  value === "add" || value === "replace" || value === "remove";

export type LocalToolDeps = {
  conversationId: string;
  store?: LocalToolStore | null;
  dream?: LocalDreamConfig;
  signal?: AbortSignal;
};

type DispatchResult =
  | { handled: true; text: string }
  | { handled: false };

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

  if (toolName === TOOL_IDS.MEMORY) {
    if (!deps.store) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "Memory store not available.",
        }),
      };
    }
    const action = isMemoryAction(args.action) ? args.action : null;
    const target = isMemoryTarget(args.target) ? args.target : null;
    if (!action) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "action must be one of: add, replace, remove.",
        }),
      };
    }
    if (!target) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "target must be one of: memory, user.",
        }),
      };
    }
    const content = typeof args.content === "string" ? args.content : "";
    const oldText = typeof args.oldText === "string" ? args.oldText : "";

    let result;
    if (action === "add") {
      result = deps.store.memoryStore.add(target, content);
    } else if (action === "replace") {
      result = deps.store.memoryStore.replace(target, oldText, content);
    } else {
      result = deps.store.memoryStore.remove(target, oldText);
    }
    return { handled: true, text: JSON.stringify(result) };
  }

  if (toolName === TOOL_IDS.READ) {
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    if (!filePath) {
      return {
        handled: true,
        text: JSON.stringify({ success: false, error: "file_path is required." }),
      };
    }
    try {
      const resolvedPath = deps.dream
        ? await ensureDreamReadPath(deps.dream, filePath)
        : filePath;
      const content = await fs.readFile(resolvedPath, "utf-8");
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
    const oldString = typeof args.old_string === "string" ? args.old_string : "";
    const newString = typeof args.new_string === "string" ? args.new_string : "";
    const replaceAll = args.replace_all === true;
    if (!filePath) {
      return {
        handled: true,
        text: JSON.stringify({ success: false, error: "file_path is required." }),
      };
    }
    try {
      const resolvedPath = deps.dream
        ? await ensureDreamWritePath(deps.dream, filePath)
        : filePath;
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
        updated = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
        count = 1;
      }
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, updated, "utf-8");
      return {
        handled: true,
        text: JSON.stringify({
          success: true,
          path: resolvedPath,
          replacements: count,
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

  if (toolName === TOOL_IDS.DREAM) {
    const dream = deps.dream;
    const summariesStore = deps.store?.threadSummariesStore;
    if (!dream || !summariesStore) {
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
      const sinceWatermark =
        typeof args.sinceWatermark === "number" ? args.sinceWatermark : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const result = await dreamList({
        stellaHome: dream.stellaHome,
        store: summariesStore,
        ...(sinceWatermark !== undefined ? { sinceWatermark } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { handled: true, text: JSON.stringify({ success: true, ...result }) };
    }
    if (action === "markProcessed") {
      const result = await dreamMarkProcessed({
        stellaHome: dream.stellaHome,
        store: summariesStore,
        ...(isThreadKeyArray(args.threadKeys) ? { threadKeys: args.threadKeys } : {}),
        ...(isStringArray(args.threadIds) ? { threadIds: args.threadIds } : {}),
        ...(isStringArray(args.extensionPaths)
          ? { extensionPaths: args.extensionPaths }
          : {}),
        ...(typeof args.watermark === "number" ? { watermark: args.watermark } : {}),
      });
      return { handled: true, text: JSON.stringify({ success: true, ...result }) };
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
