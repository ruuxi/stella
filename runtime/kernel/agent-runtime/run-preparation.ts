import { Buffer } from "node:buffer";
import type { AgentMessage } from "../agent-core/types.js";
import type { ImageContent } from "../../ai/types.js";
import {
  detectImageMediaType,
  isCompleteImage,
} from "../../ai/utils/image-payload.js";
import {
  resolveImageCaps,
  type ImageCapTarget,
} from "../../ai/utils/image-caps.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import { resolveLocalCliCwd } from "./shared.js";
import { buildSystemPrompt } from "./thread-memory.js";
import type { OrchestratorRunOptions, SubagentRunOptions } from "./types.js";
import { resizeImage } from "../shared/image-resize.js";

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;

const toImageContent = (
  attachment: RuntimeAttachmentRef,
): ImageContent | null => {
  const match = DATA_URL_RE.exec(attachment.url.trim());
  if (!match) {
    return null;
  }
  const mimeType = (attachment.mimeType?.trim() || match[1])
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith("image/")) {
    return null;
  }
  return {
    type: "image",
    mimeType,
    data: match[2],
    ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}),
  };
};

/**
 * Validate and resize inline images before they enter native agent history.
 * Invalid or unshrinkable images are omitted instead of becoming permanent,
 * replayed request failures.
 */
export const prepareRuntimeAttachments = async (
  attachments: RuntimeAttachmentRef[] | undefined,
  target: ImageCapTarget = {},
): Promise<RuntimeAttachmentRef[] | undefined> => {
  if (!attachments?.length) return attachments;
  const imageCount = attachments.filter((attachment) =>
    DATA_URL_RE.test(attachment.url.trim()),
  ).length;
  const prepared = await Promise.all(
    attachments.map(
      async (attachment): Promise<RuntimeAttachmentRef | null> => {
        const match = DATA_URL_RE.exec(attachment.url.trim());
        if (!match) return attachment;
        const claimedMimeType = (
          attachment.mimeType?.trim() || match[1]
        ).toLowerCase();
        if (!claimedMimeType.startsWith("image/")) return attachment;
        const bytes = Buffer.from(match[2], "base64");
        const detectedMimeType = detectImageMediaType(bytes);
        if (!detectedMimeType || !isCompleteImage(bytes, detectedMimeType)) {
          return null;
        }
        const resized = await resizeImage(
          bytes,
          detectedMimeType,
          resolveImageCaps({ ...target, imageCount }),
        );
        if (!resized) return null;
        return {
          ...attachment,
          mimeType: resized.mimeType,
          url: `data:${resized.mimeType};base64,${resized.data}`,
          size: Buffer.byteLength(resized.data, "base64"),
        };
      },
    ),
  );
  return prepared.filter(
    (attachment): attachment is RuntimeAttachmentRef => attachment !== null,
  );
};

export const createUserPromptMessage = (
  text: string,
  attachments?: RuntimeAttachmentRef[],
) => ({
  role: "user" as const,
  content: [
    { type: "text" as const, text },
    ...(attachments ?? [])
      .map((attachment) => toImageContent(attachment))
      .filter((attachment): attachment is ImageContent => attachment !== null),
  ],
});

export const createRuntimePromptAgentMessage = (
  message: RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] },
  timestamp: number,
): AgentMessage => {
  const content = [
    { type: "text" as const, text: message.text },
    ...(message.attachments ?? [])
      .map((attachment) => toImageContent(attachment))
      .filter((attachment): attachment is ImageContent => attachment !== null),
  ];
  if (message.messageType === "message") {
    return {
      role: "runtimeInternal",
      content,
      timestamp,
      ...(message.customType ? { customType: message.customType } : {}),
      ...(message.display !== undefined ? { display: message.display } : {}),
    };
  }
  return {
    role: "user",
    content,
    timestamp,
  };
};

const appendCurrentWorkingDirectory = (
  systemPrompt: string,
  opts: Pick<OrchestratorRunOptions, "agentType" | "stellaAppDir">,
): string => {
  const cwd = resolveLocalCliCwd({
    agentType: opts.agentType,
    stellaAppDir: opts.stellaAppDir,
  });
  if (!cwd) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\nCurrent working directory: ${cwd}`;
};

export const buildRuntimeSystemPrompt = async (
  opts: OrchestratorRunOptions & { runId?: string },
): Promise<string> => {
  const effectiveSystemPrompt = appendCurrentWorkingDirectory(
    buildSystemPrompt(opts.agentContext),
    opts,
  );
  if (!opts.hookEmitter) {
    return effectiveSystemPrompt;
  }

  // Compose every hook result in registration order; `emit` would only keep
  // the last non-empty result.
  const hookResults = await opts.hookEmitter.emitAll(
    "before_agent_start",
    {
      agentType: opts.agentType,
      systemPrompt: effectiveSystemPrompt,
      conversationId: opts.conversationId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      isUserTurn: opts.uiVisibility !== "hidden",
    },
    { agentType: opts.agentType },
  );
  let prompt = effectiveSystemPrompt;
  for (const result of hookResults) {
    if (result?.systemPromptReplace) {
      prompt = result.systemPromptReplace;
    }
    if (result?.systemPromptAppend) {
      prompt = `${prompt}\n${result.systemPromptAppend}`;
    }
  }
  return prompt;
};

export const buildSubagentSystemPrompt = async (
  opts: SubagentRunOptions & { runId?: string },
): Promise<string> => {
  const effectiveSystemPrompt = appendCurrentWorkingDirectory(
    buildSystemPrompt(opts.agentContext),
    opts,
  );
  // Symmetric with `buildRuntimeSystemPrompt` (orchestrator). Subagents
  // get the same `before_agent_start` fan-out so user extensions that
  // subscribe to the event for a subagent agentType (e.g. layering
  // additional system-prompt context onto General/Explore runs) are
  // actually invoked. The bundled self-mod hook is a no-op here because
  // it gates on `triggersSelfModDetection`, which only the orchestrator
  // declares — but extensions don't need to know that.
  if (!opts.hookEmitter) {
    return effectiveSystemPrompt;
  }
  const hookResults = await opts.hookEmitter.emitAll(
    "before_agent_start",
    {
      agentType: opts.agentType,
      systemPrompt: effectiveSystemPrompt,
      conversationId: opts.conversationId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      isUserTurn: opts.uiVisibility !== "hidden",
    },
    { agentType: opts.agentType },
  );
  let prompt = effectiveSystemPrompt;
  for (const result of hookResults) {
    if (result?.systemPromptReplace) {
      prompt = result.systemPromptReplace;
    }
    if (result?.systemPromptAppend) {
      prompt = `${prompt}\n${result.systemPromptAppend}`;
    }
  }
  return prompt;
};
