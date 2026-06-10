import { promises as fs } from "node:fs";
import path from "node:path";

import { TOOL_IDS } from "../../contracts/agent-runtime.js";
import {
  memoryFilePath,
  memorySummaryPath,
} from "../memory/dream-storage.js";
import { redactMemoryText } from "../memory/redaction.js";
import type { DreamInboxStore } from "../memory/dream-inbox-store.js";
import { localNoResponse } from "./local-tool-overrides.js";

export type LocalToolStore = {
  dreamInboxStore?: DreamInboxStore;
};

export type LocalDreamConfig = {
  stellaDataDir: string;
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

const ensureDreamWritePath = async (
  dream: LocalDreamConfig,
  filePath: string,
): Promise<string> => {
  const resolved = await resolveDreamToolPath(dream, filePath);
  const allowedFiles = await Promise.all([
    normalizePath(memoryFilePath(dream.stellaDataDir)),
    normalizePath(memorySummaryPath(dream.stellaDataDir)),
  ]);
  if (allowedFiles.includes(resolved)) {
    return resolved;
  }
  throw new Error(
    "Dream StrReplace may only edit MEMORY.md and memory_summary.md.",
  );
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
      const rows = inbox.listUnprocessed(
        limit !== undefined ? { limit } : undefined,
      );
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
