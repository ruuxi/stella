import type { AgentMessage } from "../agent-core/types.js";
import type { ImageContent } from "../../ai/types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import { shouldIncludeStellaDocumentation } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import {
  buildSelfModDocumentationPrompt,
  buildSystemPrompt,
} from "./thread-memory.js";
import type { OrchestratorRunOptions, SubagentRunOptions } from "./types.js";

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
  };
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
      ...(message.details !== undefined ? { details: message.details } : {}),
    };
  }
  return {
    role: "user",
    content,
    timestamp,
  };
};

export const buildRuntimeSystemPrompt = async (
  opts: OrchestratorRunOptions,
): Promise<string> => {
  const effectiveSystemPrompt = buildSystemPrompt(opts.agentContext);
  if (!opts.hookEmitter) {
    return effectiveSystemPrompt;
  }

  const hookResult = await opts.hookEmitter.emit(
    "before_agent_start",
    { agentType: opts.agentType, systemPrompt: effectiveSystemPrompt },
    { agentType: opts.agentType },
  );
  if (hookResult?.systemPromptReplace) {
    return hookResult.systemPromptReplace;
  }
  if (hookResult?.systemPromptAppend) {
    return `${effectiveSystemPrompt}\n${hookResult.systemPromptAppend}`;
  }
  return effectiveSystemPrompt;
};

export const buildSubagentSystemPrompt = (opts: SubagentRunOptions): string =>
  [
    buildSystemPrompt(opts.agentContext),
    shouldIncludeStellaDocumentation(opts.agentType) ||
    Boolean(opts.selfModMetadata)
      ? buildSelfModDocumentationPrompt(opts.stellaRoot)
      : "",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
