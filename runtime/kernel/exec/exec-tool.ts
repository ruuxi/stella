/**
 * Top-level `Exec` and `Wait` ToolHandlers backed by the long-lived
 * `ExecHost` worker. These are the two tools the agent allowlist actually
 * exposes; everything else lives inside `tools.*` via the registry.
 */

import type {
  ToolContext,
  ToolHandler,
  ToolHandlerExtras,
  ToolResult,
} from "../tools/types.js";
import { EXEC_TOOL_NAME, WAIT_TOOL_NAME } from "./exec-contract.js";
import type {
  ExecCellResult,
  ExecHost,
} from "./exec-host.js";

const formatToolResult = (
  result: ExecCellResult,
  summary: string,
): ToolResult => {
  const baseDetails = {
    tool: EXEC_TOOL_NAME,
    summary,
    cellId: result.cellId,
    durationMs: result.durationMs,
    content: result.content,
    calls: result.calls,
  };

  switch (result.kind) {
    case "completed": {
      const valueDescription =
        result.value === undefined
          ? "Program completed."
          : typeof result.value === "string"
            ? result.value
            : safeJson(result.value);
      return {
        result: valueDescription,
        details: {
          ...baseDetails,
          success: true,
          value: result.value,
        },
      };
    }
    case "yielded":
      return {
        result: `Cell ${result.cellId} yielded (${result.reason}). Resume with Wait({ cell_id: "${result.cellId}" }).`,
        details: {
          ...baseDetails,
          success: true,
          yielded: true,
          reason: result.reason,
        },
      };
    case "failed":
      return {
        error: `${EXEC_TOOL_NAME} failed during ${result.phase}: ${result.message}`,
        details: {
          ...baseDetails,
          success: false,
          error: { phase: result.phase, message: result.message },
        },
      };
    default:
      return { error: "Unknown Exec result." };
  }
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const buildExecHandler =
  (host: ExecHost): ToolHandler =>
  async (
    rawArgs: Record<string, unknown>,
    context: ToolContext,
    extras?: ToolHandlerExtras,
  ): Promise<ToolResult> => {
    const summary = String(rawArgs.summary ?? "").trim();
    const source = String(rawArgs.source ?? rawArgs.code ?? "");
    if (!summary) return { error: "summary is required." };
    if (!source.trim()) return { error: "source is required." };

    const timeoutMs =
      typeof rawArgs.timeoutMs === "number" && Number.isFinite(rawArgs.timeoutMs)
        ? rawArgs.timeoutMs
        : undefined;

    const result = await host.execute({
      summary,
      source,
      context,
      ...(extras ? { toolHandlerExtras: extras } : {}),
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    });

    return formatToolResult(result, summary);
  };

const buildWaitHandler =
  (host: ExecHost): ToolHandler =>
  async (
    rawArgs: Record<string, unknown>,
    _context: ToolContext,
    _extras?: ToolHandlerExtras,
  ): Promise<ToolResult> => {
    const cellId = String(rawArgs.cell_id ?? "").trim();
    if (!cellId) return { error: "cell_id is required." };
    const yieldAfterMs =
      typeof rawArgs.yield_after_ms === "number" &&
      Number.isFinite(rawArgs.yield_after_ms)
        ? rawArgs.yield_after_ms
        : undefined;
    const terminate = Boolean(rawArgs.terminate ?? false);

    let result: ExecCellResult;
    try {
      result = await host.wait({
        cellId,
        ...(typeof yieldAfterMs === "number" ? { yieldAfterMs } : {}),
        ...(terminate ? { terminate } : {}),
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return formatToolResult(result, `Wait(${cellId})`);
  };

export const createExecToolHandlers = (
  host: ExecHost,
): Record<string, ToolHandler> => ({
  [EXEC_TOOL_NAME]: buildExecHandler(host),
  [WAIT_TOOL_NAME]: buildWaitHandler(host),
});
