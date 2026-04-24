import type { AgentTool } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { TextContent } from "../../ai/types.js";
import { DEVICE_TOOL_NAMES } from "../tools/schemas.js";
import type {
  ToolContext,
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { TOOL_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import { AnyToolArgsSchema, textFromUnknown } from "./shared.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";

export const STELLA_LOCAL_TOOLS = [
  ...DEVICE_TOOL_NAMES,
  TOOL_IDS.NO_RESPONSE,
] as const;

export const getRequestedRuntimeToolNames = (
  toolsAllowlist?: string[],
): string[] =>
  Array.isArray(toolsAllowlist) && toolsAllowlist.length > 0
    ? toolsAllowlist
    : [...STELLA_LOCAL_TOOLS];

/**
 * Resolve the agent's tool allowlist against the host's catalog.
 *
 * The catalog is the single source of truth for tool metadata — every tool
 * lives as a self-contained `ToolDefinition` under
 * `runtime/kernel/tools/defs/` and is registered into the catalog by the
 * host. If a name in the allowlist isn't in the catalog, it's silently
 * dropped and a warning is logged.
 */
export const getRuntimeToolMetadata = (opts: {
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
}): ToolMetadata[] => {
  const catalog = new Map<string, ToolMetadata>(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const resolved: ToolMetadata[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const toolName of getRequestedRuntimeToolNames(opts.toolsAllowlist)) {
    if (seen.has(toolName)) continue;
    seen.add(toolName);
    const entry = catalog.get(toolName);
    if (!entry) {
      missing.push(toolName);
      continue;
    }
    resolved.push(entry);
  }
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tool-adapters] dropped unknown tools from allowlist: ${missing.join(", ")}`,
    );
  }
  return resolved;
};

const mergeToolSideEffectsIntoDetails = (
  details: unknown,
  fileChanges: ToolResult["fileChanges"],
  producedFiles: ToolResult["producedFiles"],
): unknown => {
  if (
    (!fileChanges || fileChanges.length === 0) &&
    (!producedFiles || producedFiles.length === 0)
  ) {
    return details;
  }
  const sideEffects = {
    ...(fileChanges && fileChanges.length > 0 ? { fileChanges } : {}),
    ...(producedFiles && producedFiles.length > 0 ? { producedFiles } : {}),
  };
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { ...(details as Record<string, unknown>), ...sideEffects };
  }
  // Wrap non-object details so the worker server hoists structured side
  // effects to the top level of the persisted event payload while
  // still preserving the original details under `result`.
  if (details === undefined || details === null) return sideEffects;
  return { result: details, ...sideEffects };
};

const formatToolResult = (
  toolResult: ToolResult,
): { text: string; details: unknown } => {
  if (toolResult.error) {
    return {
      text: `Error: ${toolResult.error}`,
      details: mergeToolSideEffectsIntoDetails(
        toolResult.details ?? { error: toolResult.error },
        toolResult.fileChanges,
        toolResult.producedFiles,
      ),
    };
  }

  return {
    text: textFromUnknown(toolResult.result),
    details: mergeToolSideEffectsIntoDetails(
      toolResult.details ?? toolResult.result,
      toolResult.fileChanges,
      toolResult.producedFiles,
    ),
  };
};

// Inline-image attach contract used by stella-computer (and any other CLI we
// wire up the same way): when tool output contains a substring of the form
//
//     [stella-attach-image][ <WxH>][ <N>KB][ inline=image/png] <PATH>
//
// the runtime reads the file at <PATH> and emits an image content block
// alongside the text result, so the model sees the screenshot on its very
// next turn without having to call a separate Read.
//
// The marker is stripped from the text we forward to the model so the
// model doesn't waste tokens describing a path it doesn't need to see.
//
// We intentionally do NOT trust the model to emit these markers itself —
// only output that flowed through a runtime tool (e.g. `exec_command`)
// goes through this transform. The marker can appear anywhere in the
// tool result text, including inside a JSON-stringified `output` field
// where real newlines are escaped as `\n` — that's why this regex is
// position-agnostic and excludes `"` and `\` from the path so we never
// grab past a JSON string boundary.
const STELLA_ATTACH_IMAGE_RE =
  /\[stella-attach-image\][^\n"\\]*?\s(\/[^\s\n"\\]+\.(?:png|jpg|jpeg|gif|webp))/g;

type ImageBlock = { type: "image"; mimeType: string; data: string };

const mimeForPath = (filePath: string): string => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
};

// Exported for tests. See `desktop/tests/runtime/kernel/agent-runtime/stella-attach-image.test.ts`.
export const extractAttachImageBlocks = async (
  text: string,
): Promise<{ text: string; images: ImageBlock[] }> => {
  if (!text || !text.includes("[stella-attach-image]")) {
    return { text, images: [] };
  }
  const matches: Array<{ full: string; path: string }> = [];
  for (const m of text.matchAll(STELLA_ATTACH_IMAGE_RE)) {
    if (m[1]) matches.push({ full: m[0], path: m[1] });
  }
  if (matches.length === 0) return { text, images: [] };

  const images: ImageBlock[] = [];
  // Read sequentially to keep failure messages deterministic; screenshots are
  // small and there's typically 1-2 per call.
  for (const { path: imgPath } of matches) {
    try {
      const fs = await import("node:fs/promises");
      const buf = await fs.readFile(imgPath);
      images.push({
        type: "image",
        mimeType: mimeForPath(imgPath),
        data: buf.toString("base64"),
      });
    } catch {
      // If the file vanished between CLI exit and our read, leave the marker
      // in the text so the model can still see what was attempted.
      return { text, images: [] };
    }
  }

  // Strip the marker lines from the forwarded text so we don't double-send.
  let stripped = text;
  for (const { full } of matches) {
    stripped = stripped.replace(full, "").replace(/\n{3,}/g, "\n\n");
  }
  stripped = stripped.replace(/[ \t]+\n/g, "\n").trim();
  return { text: stripped, images };
};

type RuntimeToolContextArgs = {
  toolCallId: string;
  runId: string;
  rootRunId?: string;
  agentId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  stellaRoot?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  allowedToolNames?: string[];
};

export const buildRuntimeToolContext = (
  args: RuntimeToolContextArgs,
): ToolContext => ({
  conversationId: args.conversationId,
  deviceId: args.deviceId,
  requestId: args.toolCallId,
  runId: args.runId,
  ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
  agentType: args.agentType,
  ...(args.stellaRoot ? { stellaRoot: args.stellaRoot } : {}),
  storageMode: "local",
  ...(args.agentId ? { agentId: args.agentId } : {}),
  ...(typeof args.agentDepth === "number" ? { agentDepth: args.agentDepth } : {}),
  ...(typeof args.maxAgentDepth === "number"
    ? { maxAgentDepth: args.maxAgentDepth }
    : {}),
  ...(Array.isArray(args.allowedToolNames) && args.allowedToolNames.length > 0
    ? { allowedToolNames: args.allowedToolNames }
    : {}),
});

type RuntimeToolExecutionArgs = RuntimeToolContextArgs & {
  toolName: string;
  args: Record<string, unknown>;
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  hookEmitter?: HookEmitter;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
};

export const executeRuntimeToolCall = async (
  args: RuntimeToolExecutionArgs,
): Promise<ToolResult> => {
  if (args.toolName === TOOL_IDS.NO_RESPONSE) {
    const localResult = await dispatchLocalTool(args.toolName, args.args, {
      conversationId: args.conversationId,
      store: args.store,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (localResult.handled) {
      return {
        result: localResult.text,
        details: { text: localResult.text },
      };
    }
  }

  const context = buildRuntimeToolContext(args);
  let effectiveArgs = args.args;
  if (args.hookEmitter) {
    const hookResult = await args.hookEmitter.emit(
      "before_tool",
      { tool: args.toolName, args: args.args, context },
      { tool: args.toolName, agentType: args.agentType },
    );
    if (hookResult?.cancel) {
      return {
        error: `Tool blocked: ${hookResult.reason ?? "blocked by hook"}`,
      };
    }
    if (hookResult?.args) {
      effectiveArgs = hookResult.args;
    }
  }

  let toolResult = await args.toolExecutor(
    args.toolName,
    effectiveArgs,
    context,
    args.signal,
    args.onUpdate,
  );

  if (args.hookEmitter) {
    const hookResult = await args.hookEmitter.emit(
      "after_tool",
      {
        tool: args.toolName,
        args: effectiveArgs,
        result: toolResult,
        context,
      },
      { tool: args.toolName, agentType: args.agentType },
    );
    if (hookResult?.result) {
      toolResult = hookResult.result;
    }
  }

  return toolResult;
};

export const createPiTools = (opts: {
  runId: string;
  rootRunId?: string;
  agentId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  stellaRoot?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  hookEmitter?: HookEmitter;
}): AgentTool[] => {
  const requested = getRequestedRuntimeToolNames(opts.toolsAllowlist);
  const catalog = new Map<string, ToolMetadata>(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const activeTools: AgentTool[] = [];
  const activeToolNames = new Set<string>();

  const registerTool = (toolName: string): AgentTool => {
    const entry = catalog.get(toolName);
    const metadata: ToolMetadata = entry ?? {
      name: toolName,
      description: `${toolName} tool`,
      parameters: AnyToolArgsSchema as Record<string, unknown>,
    };
    const tool: AgentTool = {
      name: toolName,
      label: toolName,
      description: metadata.description,
      parameters: metadata.parameters as typeof AnyToolArgsSchema,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const args = (params as Record<string, unknown>) ?? {};
        const toolResult = await executeRuntimeToolCall({
          toolCallId,
          toolName,
          args,
          runId: opts.runId,
          rootRunId: opts.rootRunId,
          agentId: opts.agentId,
          conversationId: opts.conversationId,
          agentType: opts.agentType,
          deviceId: opts.deviceId,
          stellaRoot: opts.stellaRoot,
          agentDepth: opts.agentDepth,
          maxAgentDepth: opts.maxAgentDepth,
          allowedToolNames: requested,
          store: opts.store,
          toolExecutor: opts.toolExecutor,
          hookEmitter: opts.hookEmitter,
          signal,
          onUpdate: onUpdate
            ? ((partialResult: ToolResult) => {
                const formattedPartial = formatToolResult(partialResult);
                onUpdate({
                  content: [{ type: "text", text: formattedPartial.text }],
                  details: formattedPartial.details,
                });
              })
            : undefined,
        });
        const formatted = formatToolResult(toolResult);
        // Detect [stella-attach-image] markers in the text and read the
        // referenced PNG(s) into image content blocks. This is what makes
        // `stella-computer snapshot` "auto-read" its screenshot — the model
        // sees the image on the very next turn with no extra Read step.
        const { text: forwardedText, images: legacyImages } =
          await extractAttachImageBlocks(formatted.text);
        const content: Array<TextContent | ImageBlock> = [];
        if (forwardedText || legacyImages.length === 0) {
          content.push({ type: "text" as const, text: forwardedText });
        }
        content.push(...legacyImages);
        return {
          content,
          details: formatted.details,
        };
      },
    };
    return tool;
  };

  for (const toolName of requested) {
    if (activeToolNames.has(toolName)) continue;
    activeToolNames.add(toolName);
    activeTools.push(registerTool(toolName));
  }

  return activeTools;
};
