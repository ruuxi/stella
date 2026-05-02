import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "../../../desktop/src/shared/contracts/file-changes.js";
import type {
  ToolContext,
  ToolHandlerExtras,
  ToolResult,
} from "./types.js";

export const MULTI_TOOL_USE_PARALLEL_TOOL_NAME = "multi_tool_use_parallel";

/**
 * Tools that mutate session state and must never be invoked concurrently
 * inside a single `multi_tool_use_parallel` batch. Mirrors Codex's
 * `supports_parallel_tool_calls: false` flag (e.g. `write_stdin` would race
 * other writes against the same PTY session).
 */
const NON_PARALLEL_TOOL_NAMES = new Set<string>([
  "apply_patch",
  "Write",
  "Edit",
  "write_stdin",
  "ask_user_question",
  "AskUserQuestion",
  "askQuestion",
  "request_credential",
  "RequestCredential",
]);

type ParallelToolDeps = {
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => Promise<ToolResult>;
};

const stringifyResult = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const normalizeToolName = (raw: unknown): string => {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.startsWith("functions.")) {
    return value.slice("functions.".length);
  }
  return value;
};

type ParallelEntryResult = {
  index: number;
  tool_name: string;
  error?: string;
  result?: unknown;
  details?: unknown;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
};

export const handleMultiToolUseParallel = async (
  deps: ParallelToolDeps,
  args: Record<string, unknown>,
  context: ToolContext,
  extras?: ToolHandlerExtras,
): Promise<ToolResult> => {
  const requested = Array.isArray(args.tool_uses) ? args.tool_uses : null;
  if (!requested || requested.length === 0) {
    return { error: "tool_uses must be a non-empty array." };
  }

  const allowedToolNames = Array.isArray(context.allowedToolNames)
    ? new Set(context.allowedToolNames)
    : null;

  // Pre-compute normalized entries so we validate the whole batch before any
  // tool runs.
  const normalizedEntries = requested.map((entry, index) => {
    const record =
      entry && typeof entry === "object"
        ? (entry as { recipient_name?: unknown; parameters?: unknown })
        : null;
    const toolName = normalizeToolName(record?.recipient_name);
    const parameters =
      record?.parameters && typeof record.parameters === "object"
        ? (record.parameters as Record<string, unknown>)
        : {};
    return { index, toolName, parameters };
  });

  const preflightResults: ParallelEntryResult[] = [];
  for (const { index, toolName } of normalizedEntries) {
    if (!toolName) {
      preflightResults.push({
        index,
        tool_name: "",
        error: "recipient_name is required.",
      });
    } else if (toolName === MULTI_TOOL_USE_PARALLEL_TOOL_NAME) {
      preflightResults.push({
        index,
        tool_name: toolName,
        error: "Nested multi_tool_use_parallel calls are not allowed.",
      });
    } else if (NON_PARALLEL_TOOL_NAMES.has(toolName)) {
      preflightResults.push({
        index,
        tool_name: toolName,
        error: `${toolName} is not safe to run inside multi_tool_use_parallel; call it directly.`,
      });
    } else if (allowedToolNames && !allowedToolNames.has(toolName)) {
      preflightResults.push({
        index,
        tool_name: toolName,
        error: `${toolName} is not available in this agent context.`,
      });
    }
  }

  if (preflightResults.length > 0) {
    const invalidIndexes = new Set(preflightResults.map((entry) => entry.index));
    const results: ParallelEntryResult[] = normalizedEntries.map((entry) => {
      const error = preflightResults.find(
        (result) => result.index === entry.index,
      );
      if (error) return error;
      return {
        index: entry.index,
        tool_name: entry.toolName,
        error:
          "Skipped because another tool in this multi_tool_use_parallel batch is invalid.",
      };
    });
    const rendered = results
      .map((entry) => {
        if (entry.error) {
          return `### ${entry.tool_name || `tool_${entry.index + 1}`}\nError: ${entry.error}`;
        }
        const text = stringifyResult(entry.result);
        return `### ${entry.tool_name}\n${text || "(no output)"}`;
      })
      .join("\n\n");
    return {
      result: rendered,
      details: {
        results,
        rejectedBeforeExecution: true,
        invalidIndexes: Array.from(invalidIndexes),
      },
    };
  }

  const results = await Promise.all(
    normalizedEntries.map(async ({ index, toolName, parameters }) => {
      const nested = await deps.executeTool(
        toolName,
        parameters,
        context,
        extras?.signal,
      );
      return {
        index,
        tool_name: toolName,
        ...(nested.error
          ? { error: nested.error }
          : { result: nested.result }),
        ...(nested.details !== undefined ? { details: nested.details } : {}),
        ...(nested.fileChanges ? { fileChanges: nested.fileChanges } : {}),
        ...(nested.producedFiles ? { producedFiles: nested.producedFiles } : {}),
      };
    }),
  );

  const fileChanges: FileChangeRecord[] = [];
  const producedFiles: ProducedFileRecord[] = [];
  for (const result of results) {
    if ("fileChanges" in result && Array.isArray(result.fileChanges)) {
      fileChanges.push(...result.fileChanges);
    }
    if ("producedFiles" in result && Array.isArray(result.producedFiles)) {
      producedFiles.push(...result.producedFiles);
    }
  }

  const rendered = results
    .map((entry) => {
      if ("error" in entry && entry.error) {
        return `### ${entry.tool_name || `tool_${entry.index + 1}`}\nError: ${entry.error}`;
      }
      const text = stringifyResult("result" in entry ? entry.result : undefined);
      return `### ${entry.tool_name}\n${text || "(no output)"}`;
    })
    .join("\n\n");

  return {
    result: rendered,
    details: { results },
    ...(fileChanges.length > 0 ? { fileChanges } : {}),
    ...(producedFiles.length > 0 ? { producedFiles } : {}),
  };
};
