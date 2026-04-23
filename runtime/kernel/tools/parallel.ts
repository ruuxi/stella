import type {
  ToolContext,
  ToolHandlerExtras,
  ToolResult,
} from "./types.js";

export const MULTI_TOOL_USE_PARALLEL_TOOL_NAME = "multi_tool_use.parallel";

/**
 * Tools that mutate session state and must never be invoked concurrently
 * inside a single `multi_tool_use.parallel` batch. Mirrors Codex's
 * `supports_parallel_tool_calls: false` flag (e.g. `write_stdin` would race
 * other writes against the same PTY session).
 */
const NON_PARALLEL_TOOL_NAMES = new Set<string>([
  "write_stdin",
  "ask_user_question",
  "AskUserQuestion",
  "askQuestion",
  "request_credential",
  "RequestCredential",
]);

export const MULTI_TOOL_USE_PARALLEL_JSON_SCHEMA = {
  type: "object",
  properties: {
    tool_uses: {
      type: "array",
      description:
        "Independent tool calls to execute concurrently. Only batch calls that do not depend on each other.",
      items: {
        type: "object",
        properties: {
          recipient_name: {
            type: "string",
            description:
              "Tool name to invoke. Accepts either bare Stella tool names like `exec_command` or `functions.exec_command`.",
          },
          parameters: {
            type: "object",
            description: "Arguments for the nested tool call.",
            additionalProperties: true,
          },
        },
        required: ["recipient_name", "parameters"],
      },
    },
  },
  required: ["tool_uses"],
} as const;

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

  const results = await Promise.all(
    normalizedEntries.map(async ({ index, toolName, parameters }) => {
      if (!toolName) {
        return {
          index,
          tool_name: "",
          error: "recipient_name is required.",
        };
      }
      if (toolName === MULTI_TOOL_USE_PARALLEL_TOOL_NAME) {
        return {
          index,
          tool_name: toolName,
          error: "Nested multi_tool_use.parallel calls are not allowed.",
        };
      }
      if (NON_PARALLEL_TOOL_NAMES.has(toolName)) {
        return {
          index,
          tool_name: toolName,
          error: `${toolName} is not safe to run inside multi_tool_use.parallel; call it directly.`,
        };
      }
      if (allowedToolNames && !allowedToolNames.has(toolName)) {
        return {
          index,
          tool_name: toolName,
          error: `${toolName} is not available in this agent context.`,
        };
      }

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
      };
    }),
  );

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
  };
};
