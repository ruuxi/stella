import { promises as fs } from "node:fs";

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
import { TOOL_IDS } from "../../contracts/agent-runtime.js";
import { AnyToolArgsSchema, textFromUnknown } from "./shared.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";
import {
  sanitizeToolError,
  sanitizeToolResult,
  sanitizeToolVisibleText,
} from "../tools/safety.js";
import { resolveImageMimeType } from "../shared/image-mime.js";
import { readImageFileSettled } from "../shared/read-image-file.js";
import { formatDimensionNote, resizeImage } from "../shared/image-resize.js";
import {
  detectImageMediaType,
  isCompleteImage,
} from "../../ai/utils/image-payload.js";

export const STELLA_LOCAL_TOOLS = [
  ...DEVICE_TOOL_NAMES,
  TOOL_IDS.NO_RESPONSE,
] as const;

const TOOL_SEARCH_TOOL_NAME = "tool_search";

const formatToolLabel = (toolName: string): string =>
  toolName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || toolName;

const formatToolWorkingText = (metadata: ToolMetadata): string =>
  metadata.workingText ?? `Running ${metadata.label ?? formatToolLabel(metadata.name)}`;

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
    const error = sanitizeToolError(toolResult.error);
    return {
      text: `Error: ${error}`,
      details: mergeToolSideEffectsIntoDetails(
        sanitizeToolResult(toolResult.details ?? { error }),
        toolResult.fileChanges,
        toolResult.producedFiles,
      ),
    };
  }

  const result = sanitizeToolResult(toolResult.result);
  return {
    text: sanitizeToolVisibleText(textFromUnknown(result)),
    details: mergeToolSideEffectsIntoDetails(
      sanitizeToolResult(toolResult.details ?? result),
      toolResult.fileChanges,
      toolResult.producedFiles,
    ),
  };
};

export const MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS = 30_000;

export const truncateModelVisibleToolText = (
  text: string,
  maxChars = MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS,
): { text: string; truncated: boolean; originalChars: number } => {
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars };
  }

  const lineCount = text.length > 0 ? text.split("\n").length : 0;
  const marker = `\n\n[Tool output truncated to ${maxChars} characters. Total output lines: ${lineCount}.]\n\n`;
  const available = maxChars - marker.length;
  if (available <= 0) {
    return {
      text: text.slice(0, Math.max(0, maxChars)),
      truncated: true,
      originalChars,
    };
  }

  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  const omittedChars = originalChars - headChars - tailChars;
  const finalMarker = `\n\n[Tool output truncated: ${omittedChars} characters omitted. Total output lines: ${lineCount}.]\n\n`;
  const finalAvailable = maxChars - finalMarker.length;
  const finalHeadChars = Math.ceil(finalAvailable / 2);
  const finalTailChars = Math.floor(finalAvailable / 2);
  return {
    text: `${text.slice(0, finalHeadChars)}${finalMarker}${text.slice(-finalTailChars)}`,
    truncated: true,
    originalChars,
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
// position-agnostic and excludes `"` from the path so we never grab past a
// JSON string boundary. Windows paths can be raw (`C:\...`) or JSON-escaped
// (`C:\\...`), so captured paths are unescaped before reading.
const STELLA_ATTACH_IMAGE_RE =
  /\[stella-attach-image\][^\n"]*?\s((?:\/[^\s\n"]+|[A-Za-z]:[\\/][^\s\n"]+?)\.(?:png|jpg|jpeg|gif|webp))/g;

type ImageBlock = { type: "image"; mimeType: string; data: string };

/**
 * Per-image cap for vision attachments, measured on the base64 payload.
 * Anthropic rejects any image whose base64 exceeds 10MiB with a fatal
 * 400 that kills the whole turn — so oversized files are never attached
 * raw. `resizeImage` (pi-mono's Photon-based pipeline) normally shrinks
 * anything large well under this; the cap only matters on its null
 * fallback path.
 */
const MAX_ATTACH_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;

const base64Length = (binaryBytes: number) => Math.ceil(binaryBytes / 3) * 4;

const omittedAttachImageNote = (imgPath: string, binaryBytes: number) =>
  `[Image omitted: ${imgPath} is ${(binaryBytes / (1024 * 1024)).toFixed(1)}MB and could not be resized below the inline image size limit.]`;

const unreadableAttachImageNote = (imgPath: string) =>
  `[Image omitted: ${imgPath} could not be decoded as a valid image (it may be corrupt or truncated) and was skipped.]`;

const normalizeAttachImagePath = (filePath: string) =>
  /^[A-Za-z]:\\\\/.test(filePath) ? filePath.replace(/\\\\/g, "\\") : filePath;

const tokenizeToolSearch = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const clampToolSearchLimit = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 6;
  return Math.max(1, Math.min(12, Math.floor(value)));
};

const scoreDeferredTool = (tool: ToolMetadata, queryTokens: string[]) => {
  const haystack = [
    tool.name,
    tool.description,
    ...(tool.deferred?.searchTerms ?? []),
  ]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (tool.name.toLowerCase().includes(token)) score += 5;
    if (haystack.includes(token)) score += 2;
  }
  return score;
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
    if (m[1])
      matches.push({ full: m[0], path: normalizeAttachImagePath(m[1]) });
  }
  if (matches.length === 0) return { text, images: [] };

  const images: ImageBlock[] = [];
  const markerReplacements: Array<{ full: string; replacement: string }> = [];
  // Read sequentially to keep failure messages deterministic; screenshots are
  // small and there's typically 1-2 per call.
  for (const { full, path: imgPath } of matches) {
    try {
      // Settle the read against the capture -> read race: a screenshot the
      // agent just captured can still be mid-flush when its path reaches us,
      // and reading it early yields a truncated PNG that 400s Anthropic
      // fatally. `readImageFileSettled` re-reads until the bytes complete (or
      // the file stops growing / the budget is spent); the completeness gate
      // below stays as defense-in-depth for genuinely corrupt files.
      const buf = await readImageFileSettled(imgPath);
      const mimeType = resolveImageMimeType(imgPath, buf);
      if (!mimeType) {
        return { text, images: [] };
      }
      // Pi-style auto-resize: pass-through when already small (≤2000px
      // and under the byte cap — e.g. every stella-computer screenshot,
      // which the native helper pre-caps at 1024px, so screenshot-pixel
      // coordinates stay 1:1), otherwise shrink to fit. The dimension
      // note tells the model how to map coordinates back when a resize
      // did happen.
      const resized = await resizeImage(buf, mimeType);
      if (resized) {
        const note = formatDimensionNote(resized);
        markerReplacements.push({ full, replacement: note ?? "" });
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: resized.data,
        });
        continue;
      }
      // Resize unavailable: either Photon is missing (image is likely fine)
      // OR Photon threw because the bytes can't be decoded — which is exactly
      // what a truncated/corrupt capture (e.g. a screenshot read mid-write)
      // looks like. Only attach the raw file when it's a structurally
      // complete, supported image; a broken payload inlined into the request
      // 400s fatally ("Could not process image") and, because it lands in
      // thread history, poisons every subsequent resume.
      const detected = detectImageMediaType(buf);
      if (!detected || !isCompleteImage(buf, detected)) {
        markerReplacements.push({
          full,
          replacement: unreadableAttachImageNote(imgPath),
        });
        continue;
      }
      // Over the provider per-image cap: swap the marker for a note rather
      // than inline an over-cap image that would 400 fatally.
      if (base64Length(buf.length) > MAX_ATTACH_IMAGE_BASE64_BYTES) {
        markerReplacements.push({
          full,
          replacement: omittedAttachImageNote(imgPath, buf.length),
        });
        continue;
      }
      markerReplacements.push({ full, replacement: "" });
      images.push({
        type: "image",
        mimeType,
        data: buf.toString("base64"),
      });
    } catch {
      // If the file vanished between CLI exit and our read, leave the marker
      // in the text so the model can still see what was attempted.
      return { text, images: [] };
    }
  }

  // Strip attached markers (and swap oversized ones for their notes) so we
  // don't double-send paths the model no longer needs.
  let stripped = text;
  for (const { full, replacement } of markerReplacements) {
    stripped = stripped.replace(full, replacement).replace(/\n{3,}/g, "\n\n");
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
  stellaAppDir?: string;
  stellaDataDir?: string;
  toolWorkspaceRoot?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  allowedToolNames?: string[];
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
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
  ...(args.stellaAppDir ? { stellaAppDir: args.stellaAppDir } : {}),
  ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
  ...(args.toolWorkspaceRoot
    ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
    : {}),
  storageMode: "local",
  ...(args.agentId ? { agentId: args.agentId } : {}),
  ...(typeof args.agentDepth === "number"
    ? { agentDepth: args.agentDepth }
    : {}),
  ...(typeof args.maxAgentDepth === "number"
    ? { maxAgentDepth: args.maxAgentDepth }
    : {}),
  ...(Array.isArray(args.allowedToolNames) && args.allowedToolNames.length > 0
    ? { allowedToolNames: args.allowedToolNames }
    : {}),
  ...(args.connectorDeliveryTarget
    ? { connectorDeliveryTarget: args.connectorDeliveryTarget }
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
  stellaAppDir?: string;
  stellaDataDir?: string;
  toolWorkspaceRoot?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
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
  const deferredTools = [...catalog.values()].filter((tool) => tool.deferred);
  const activeTools: AgentTool[] = [];
  const activeToolNames = new Set<string>();

  const registerTool = (toolName: string): AgentTool => {
    const entry = catalog.get(toolName);
    const metadata: ToolMetadata = entry ?? {
      name: toolName,
      label: formatToolLabel(toolName),
      description: `${toolName} tool`,
      parameters: AnyToolArgsSchema as Record<string, unknown>,
    };
    const tool: AgentTool = {
      name: toolName,
      label: metadata.label ?? formatToolLabel(toolName),
      workingText: formatToolWorkingText(metadata),
      description: metadata.description,
      parameters: metadata.parameters as typeof AnyToolArgsSchema,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const args = (params as Record<string, unknown>) ?? {};
        if (toolName === TOOL_SEARCH_TOOL_NAME) {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: tool_search requires a non-empty query.",
                },
              ],
              details: { error: "missing_query" },
            };
          }
          const queryTokens = tokenizeToolSearch(query);
          const connectorProvider = opts.connectorDeliveryTarget?.provider;
          const matches = deferredTools
            .filter((tool) => {
              const requiredProvider = tool.deferred?.requiredConnectorProvider;
              return !requiredProvider || requiredProvider === connectorProvider;
            })
            .map((tool) => ({ tool, score: scoreDeferredTool(tool, queryTokens) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              return left.tool.name.localeCompare(right.tool.name);
            })
            .slice(0, clampToolSearchLimit(args.limit));

          for (const { tool } of matches) {
            if (activeToolNames.has(tool.name)) continue;
            activeToolNames.add(tool.name);
            activeTools.push(registerTool(tool.name));
          }

          const toolNames = matches.map(({ tool }) => tool.name);
          onUpdate?.({
            content: [
              {
                type: "text",
                text:
                  toolNames.length > 0
                    ? `Found ${toolNames.length} matching tool${toolNames.length === 1 ? "" : "s"}.`
                    : "No matching tools found.",
              },
            ],
            details: {
              statusText:
                toolNames.length > 0
                  ? `Found ${toolNames.length} matching tool${toolNames.length === 1 ? "" : "s"}`
                  : "No matching tools found",
            },
          });
          const unavailableHint =
            connectorProvider === "linq"
              ? ""
              : " Linq/iMessage tools are only available while replying to a Linq connector conversation.";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  toolNames.length > 0
                    ? `Exposed deferred tools for the next call: ${toolNames.join(", ")}.`
                    : `No deferred tools matched "${query}".${unavailableHint}`,
              },
            ],
            details: {
              query,
              exposedTools: toolNames,
            },
          };
        }
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
          stellaAppDir: opts.stellaAppDir,
          stellaDataDir: opts.stellaDataDir,
          toolWorkspaceRoot: opts.toolWorkspaceRoot,
          agentDepth: opts.agentDepth,
          maxAgentDepth: opts.maxAgentDepth,
          connectorDeliveryTarget: opts.connectorDeliveryTarget,
          allowedToolNames: [...activeToolNames],
          store: opts.store,
          toolExecutor: opts.toolExecutor,
          hookEmitter: opts.hookEmitter,
          signal,
          onUpdate: onUpdate
            ? (partialResult: ToolResult) => {
                const formattedPartial = formatToolResult(partialResult);
                const truncatedPartial = truncateModelVisibleToolText(
                  formattedPartial.text,
                );
                onUpdate({
                  content: [{ type: "text", text: truncatedPartial.text }],
                  details: formattedPartial.details,
                });
              }
            : undefined,
        });
        const formatted = formatToolResult(toolResult);
        // Detect [stella-attach-image] markers in the text and read the
        // referenced PNG(s) into image content blocks. This is what makes
        // `stella-computer snapshot` "auto-read" its screenshot — the model
        // sees the image on the very next turn with no extra Read step.
        const { text: forwardedText, images: legacyImages } =
          await extractAttachImageBlocks(formatted.text);
        const truncatedText = truncateModelVisibleToolText(forwardedText);
        const content: Array<TextContent | ImageBlock> = [];
        const screenshotNote =
          legacyImages.length > 0
            ? "\n\n[Screenshot attached below. If the accessibility tree is sparse or missing the visible control, inspect this image directly and use screenshot x/y coordinates.]"
            : "";
        if (truncatedText.text || legacyImages.length === 0) {
          content.push({
            type: "text" as const,
            text: `${truncatedText.text}${screenshotNote}`,
          });
        } else if (screenshotNote) {
          content.push({
            type: "text" as const,
            text: screenshotNote.trim(),
          });
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
