import { promises as fs } from "node:fs";

import type { AgentMessage, AgentTool } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { TextContent } from "../../ai/types.js";
import { DEVICE_TOOL_NAMES } from "../tools/schemas.js";
import type { AgentModelConfigSnapshot } from "../../contracts/agent-engine.js";
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
  MAX_IMAGE_BASE64_BYTES,
} from "../../ai/utils/image-payload.js";
import {
  resolveImageCaps,
  type ImageCapTarget,
} from "../../ai/utils/image-caps.js";

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
  metadata.workingText ??
  `Running ${metadata.label ?? formatToolLabel(metadata.name)}`;

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

// Final native Pi tool results bypass this legacy cap and are normalized
// request-only in shared.ts. Keep this bound for live partial updates and
// external-engine dynamic-tool adapters, which do not use the Pi context
// transform.
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

// Inline-image attach contract used by diagnostic tool output and other
// runtime emitters: when tool output contains a substring of the form
//
//     [stella-attach-image][ <WxH>][ <N>KB][ inline=image/png] <PATH>
//     [stella-attach-image] ... path="<JSON-escaped absolute path>"
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
// position-agnostic. New emitters should use `path=${JSON.stringify(path)}`
// so spaces, quotes, non-ASCII, and Windows separators survive transport.
// Legacy whitespace-delimited paths remain supported.
const STELLA_ATTACH_IMAGE_MARKER = "[stella-attach-image]";
const ATTACH_IMAGE_EXTENSION_RE = /\.(?:png|jpg|jpeg|gif|webp)$/i;
const ABSOLUTE_IMAGE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

type AttachImageMatch = {
  full: string;
  path: string;
  detailOriginal: boolean;
};

const parseAttachImageMatches = (text: string): AttachImageMatch[] => {
  const matches: AttachImageMatch[] = [];
  let markerStart = text.indexOf(STELLA_ATTACH_IMAGE_MARKER);
  while (markerStart >= 0) {
    const nextMarker = text.indexOf(
      STELLA_ATTACH_IMAGE_MARKER,
      markerStart + STELLA_ATTACH_IMAGE_MARKER.length,
    );
    const newline = text.indexOf("\n", markerStart);
    const markerEnd = Math.min(
      nextMarker < 0 ? text.length : nextMarker,
      newline < 0 ? text.length : newline,
    );
    const marker = text.slice(markerStart, markerEnd);
    const pathAssignment = /\bpath\s*=\s*("(?:\\.|[^"\\])*")/.exec(marker);
    const quotedFallback = pathAssignment
      ? null
      : /(?:^|\s)("(?:\\.|[^"\\])*")/.exec(marker);
    const legacyFallback =
      pathAssignment || quotedFallback
        ? null
        : /(?:^|\s)((?:\/[^\s"]+|[A-Za-z]:[\\/][^\s"]+?)\.(?:png|jpg|jpeg|gif|webp))/i.exec(
            marker,
          );
    const token = pathAssignment?.[1] ?? quotedFallback?.[1];
    let imagePath: string | undefined;
    if (token) {
      try {
        imagePath = JSON.parse(token) as string;
      } catch {
        imagePath = undefined;
      }
    } else if (legacyFallback?.[1]) {
      imagePath = normalizeAttachImagePath(legacyFallback[1]);
    }
    if (
      imagePath &&
      ABSOLUTE_IMAGE_PATH_RE.test(imagePath) &&
      ATTACH_IMAGE_EXTENSION_RE.test(imagePath)
    ) {
      const pathEnd =
        markerStart +
        (pathAssignment?.index ??
          quotedFallback?.index ??
          legacyFallback?.index ??
          0) +
        (pathAssignment?.[0].length ??
          quotedFallback?.[0].length ??
          legacyFallback?.[0].length ??
          marker.length);
      matches.push({
        full: text.slice(markerStart, pathEnd),
        path: imagePath,
        detailOriginal: /\bdetail=original\b/.test(marker),
      });
    }
    markerStart = nextMarker;
  }
  return matches;
};

type ImageBlock = {
  type: "image";
  mimeType: string;
  data: string;
  sourcePath: string;
};

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
  target: ImageCapTarget = {},
): Promise<{ text: string; images: ImageBlock[] }> => {
  if (!text || !text.includes("[stella-attach-image]")) {
    return { text, images: [] };
  }
  let jsonValue: unknown;
  try {
    jsonValue = JSON.parse(text);
  } catch {
    jsonValue = undefined;
  }
  const jsonStrings: string[] = [];
  const collectJsonStrings = (value: unknown) => {
    if (typeof value === "string") {
      jsonStrings.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collectJsonStrings);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collectJsonStrings);
    }
  };
  if (jsonValue !== undefined) collectJsonStrings(jsonValue);
  const sourceStrings = jsonStrings.length > 0 ? jsonStrings : [text];
  const matches = sourceStrings.flatMap(parseAttachImageMatches);
  if (matches.length === 0) return { text, images: [] };

  const images: ImageBlock[] = [];
  const markerReplacements: Array<{ full: string; replacement: string }> = [];
  // Read sequentially to keep failure messages deterministic; screenshots are
  // small and there's typically 1-2 per call.
  for (const { full, path: imgPath, detailOriginal } of matches) {
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
        markerReplacements.push({
          full,
          replacement: unreadableAttachImageNote(imgPath),
        });
        continue;
      }
      // Provider-aware auto-resize: pass-through when the image already fits
      // the resolved target's dimension + byte caps (e.g. computer-use
      // screenshots that the native service pre-caps at 1024px, so screenshot
      // coordinates stay 1:1), otherwise shrink to fit that target.
      // `detail=original` lifts the caps to the provider's
      // hard ceiling so a deliberate full-res read isn't downscaled. The
      // dimension note tells the model how to map coordinates back when a
      // resize did happen.
      const caps = resolveImageCaps({
        ...target,
        imageCount: matches.length,
        detailOriginal,
      });
      const resized = await resizeImage(buf, mimeType, caps);
      if (resized) {
        const note = formatDimensionNote(resized);
        markerReplacements.push({ full, replacement: note ?? "" });
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: resized.data,
          sourcePath: imgPath,
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
      // We already prefer resizing-to-fit above: `resizeImage` shrinks any
      // large image well under the ceiling, so this raw-attach fallback is
      // only reached when resize is unavailable (Photon missing) or returned
      // null. Guard it against the *shared* per-image ceiling
      // (`MAX_IMAGE_BASE64_BYTES`, the same value the Anthropic send boundary
      // enforces): swap the marker for a note rather than inline an over-cap
      // image. Using the shared constant means an image can't pass here and
      // then be silently dropped at the wire.
      if (base64Length(buf.length) > MAX_IMAGE_BASE64_BYTES) {
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
        sourcePath: imgPath,
      });
    } catch {
      // If the file vanished between CLI exit and our read, leave the marker
      // in the text so the model can still see what was attempted, but keep
      // processing sibling markers so one missing image cannot discard them.
      markerReplacements.push({ full, replacement: full });
      continue;
    }
  }

  // Strip attached markers (and swap oversized ones for their notes) so we
  // don't double-send paths the model no longer needs.
  let stripped = text;
  if (jsonStrings.length > 0) {
    let replacementIndex = 0;
    const replaceJsonStrings = (value: unknown): unknown => {
      if (typeof value === "string") {
        let replaced = value;
        for (const match of parseAttachImageMatches(value)) {
          const replacement = markerReplacements[replacementIndex++];
          if (replacement?.full === match.full) {
            replaced = replaced.replace(
              replacement.full,
              replacement.replacement,
            );
          }
        }
        return replaced;
      }
      if (Array.isArray(value)) return value.map(replaceJsonStrings);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            replaceJsonStrings(entry),
          ]),
        );
      }
      return value;
    };
    stripped = JSON.stringify(replaceJsonStrings(jsonValue), null, 2);
    return { text: stripped, images };
  }
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
  parentAgentId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  allowedToolNames?: string[];
  deferImageDeliveryAck?: boolean;
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
  ...(args.parentAgentId ? { parentAgentId: args.parentAgentId } : {}),
  ...(typeof args.agentDepth === "number"
    ? { agentDepth: args.agentDepth }
    : {}),
  ...(typeof args.maxAgentDepth === "number"
    ? { maxAgentDepth: args.maxAgentDepth }
    : {}),
  ...(args.modelConfigSnapshot
    ? { modelConfigSnapshot: args.modelConfigSnapshot }
    : {}),
  ...(Array.isArray(args.allowedToolNames) && args.allowedToolNames.length > 0
    ? { allowedToolNames: args.allowedToolNames }
    : {}),
  ...(args.deferImageDeliveryAck ? { deferImageDeliveryAck: true } : {}),
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
  parentAgentId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
  /** Durable transcript used to restore tools exposed on earlier turns. */
  historyMessages?: AgentMessage[];
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  hookEmitter?: HookEmitter;
  /**
   * Resolved target provider/model for this run, so `[stella-attach-image]`
   * screenshots are resized to the best quality that provider supports
   * (e.g. Anthropic's 2576px high-res tier) instead of a blunt global cap.
   */
  imageCapTarget?: ImageCapTarget;
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
              return (
                !requiredProvider || requiredProvider === connectorProvider
              );
            })
            .map((tool) => ({
              tool,
              score: scoreDeferredTool(tool, queryTokens),
            }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              return left.tool.name.localeCompare(right.tool.name);
            })
            .slice(0, clampToolSearchLimit(args.limit));

          const addedToolNames: string[] = [];
          for (const { tool } of matches) {
            if (activeToolNames.has(tool.name)) continue;
            activeToolNames.add(tool.name);
            activeTools.push(registerTool(tool.name));
            addedToolNames.push(tool.name);
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
            ...(addedToolNames.length > 0 ? { addedToolNames } : {}),
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
          parentAgentId: opts.parentAgentId,
          agentDepth: opts.agentDepth,
          maxAgentDepth: opts.maxAgentDepth,
          modelConfigSnapshot: opts.modelConfigSnapshot,
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
        // Detect [stella-attach-image] markers in diagnostic tool output and
        // read the referenced PNG(s) into image content blocks. The model sees
        // the screenshot on the very next turn with no extra Read step.
        const { text: forwardedText, images: legacyImages } =
          await extractAttachImageBlocks(formatted.text, opts.imageCapTarget);
        const content: Array<TextContent | ImageBlock> = [];
        const screenshotNote =
          legacyImages.length > 0
            ? "\n\n[Image attached below. Inspect it directly. If it is a UI screenshot and the accessibility tree is sparse or missing a visible control, use screenshot x/y coordinates.]"
            : "";
        if (forwardedText || legacyImages.length === 0) {
          content.push({
            type: "text" as const,
            text: `${forwardedText}${screenshotNote}`,
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
          ...(typeof toolResult.modelOutputTokens === "number"
            ? { modelOutputTokens: toolResult.modelOutputTokens }
            : {}),
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

  const connectorProvider = opts.connectorDeliveryTarget?.provider;
  const restoreDeferredTool = (toolName: string) => {
    if (activeToolNames.has(toolName)) return;
    const metadata = catalog.get(toolName);
    if (!metadata?.deferred) return;
    const requiredProvider = metadata.deferred.requiredConnectorProvider;
    if (requiredProvider && requiredProvider !== connectorProvider) return;
    activeToolNames.add(toolName);
    activeTools.push(registerTool(toolName));
  };
  for (const message of opts.historyMessages ?? []) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") restoreDeferredTool(block.name);
      }
      continue;
    }
    if (message.role === "toolResult") {
      for (const toolName of message.addedToolNames ?? []) {
        restoreDeferredTool(toolName);
      }
    }
  }

  return activeTools;
};
