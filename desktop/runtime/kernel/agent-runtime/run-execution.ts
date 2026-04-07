import type { AgentEvent, AgentMessage } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { RuntimeAttachmentRef } from "../../protocol/index.js";
import {
  subscribeRuntimeAgentEvents,
  type RuntimeRunEventRecorder,
} from "./run-events.js";
import { createUserPromptMessage } from "./run-preparation.js";
import {
  getAgentCompletion,
  now,
} from "./shared.js";
import type { RuntimeRunCallbacks } from "./types.js";
import {
  containsLeakedInternalToolTranscript,
  sanitizeAssistantText,
} from "../internal-tool-transcript.js";
import { persistThreadPayloadMessage } from "./thread-memory.js";

const MAX_INTERNAL_TOOL_TRANSCRIPT_RECOVERY_ATTEMPTS = 2;
const INTERNAL_TOOL_TRANSCRIPT_FALLBACK_REPLY =
  "I ran into an internal formatting issue while checking that task. Ask again and I'll reply normally.";
const INTERNAL_TOOL_TRANSCRIPT_RECOVERY_PROMPT =
  [
    "System correction: your previous reply exposed Stella's internal tool transcript.",
    "Do not output raw tool call blocks, request IDs, JSON arguments, or thread IDs.",
    "Based on the tool results already in context, answer the user normally in plain language.",
    "If you do not need to say anything else to the user, call NoResponse instead of exposing internal state.",
  ].join("\n");

type RuntimeExecutableAgent = {
  state: {
    messages: AgentMessage[];
  };
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  prompt: (
    message:
      | (ReturnType<typeof createUserPromptMessage> & { timestamp: number })
      | Array<ReturnType<typeof createUserPromptMessage> & { timestamp: number }>,
  ) => Promise<void>;
  followUp: (message: ReturnType<typeof createUserPromptMessage> & { timestamp: number }) => void;
  continue: () => Promise<void>;
  abort: () => void;
};

export const executeRuntimeAgentPrompt = async (args: {
  agent: RuntimeExecutableAgent;
  promptText?: string;
  attachments?: RuntimeAttachmentRef[];
  promptMessages?: Array<{
    text: string;
    attachments?: RuntimeAttachmentRef[];
    uiVisibility?: "visible" | "hidden";
  }>;
  runId: string;
  agentType: string;
  recorder: RuntimeRunEventRecorder;
  abortSignal?: AbortSignal;
  callbacks?: Partial<RuntimeRunCallbacks>;
  onProgress?: (chunk: string) => void;
  displayEventHandler?: (event: AgentEvent) => boolean;
  hookEmitter?: HookEmitter;
  threadStore?: import("../storage/runtime-store.js").RuntimeStore;
  threadKey?: string;
  onAfterPrompt?: () => Promise<void> | void;
  onCleanup?: () => Promise<void> | void;
}): Promise<{ finalText: string; errorMessage?: string }> => {
  const abortHandler = () => args.agent.abort();
  args.abortSignal?.addEventListener("abort", abortHandler);

  const unsubscribe = subscribeRuntimeAgentEvents({
    agent: args.agent,
    runId: args.runId,
    agentType: args.agentType,
    recorder: args.recorder,
    callbacks: args.callbacks,
    onProgress: args.onProgress,
    displayEventHandler: args.displayEventHandler,
    hookEmitter: args.hookEmitter,
    threadStore: args.threadStore,
    threadKey: args.threadKey,
  });

  try {
    const promptInputs =
      args.promptMessages && args.promptMessages.length > 0
        ? args.promptMessages
        : [{
            text: args.promptText ?? "",
            attachments: args.attachments,
          }];
    const promptTimestamp = now();
    const promptMessages = promptInputs.map((message, index) => ({
      ...createUserPromptMessage(message.text, message.attachments),
      timestamp: promptTimestamp + index,
    }));
    for (const [index, promptMessage] of promptMessages.entries()) {
      if (args.threadStore && args.threadKey) {
        persistThreadPayloadMessage(args.threadStore, {
          threadKey: args.threadKey,
          payload: promptMessage,
        });
      }
      const uiVisibility = promptInputs[index]?.uiVisibility;
      if (uiVisibility) {
        args.callbacks?.onUserMessage?.({
          text: promptInputs[index]!.text,
          timestamp: promptMessage.timestamp,
          uiVisibility,
        });
      }
    }
    await args.agent.prompt(promptMessages);
    await args.onAfterPrompt?.();
    let completion = getAgentCompletion(args.agent);
    let recoveryAttempts = 0;

    while (
      containsLeakedInternalToolTranscript(completion.finalText) &&
      recoveryAttempts < MAX_INTERNAL_TOOL_TRANSCRIPT_RECOVERY_ATTEMPTS
    ) {
      args.agent.followUp({
        ...createUserPromptMessage(INTERNAL_TOOL_TRANSCRIPT_RECOVERY_PROMPT),
        timestamp: now(),
      });
      await args.agent.continue();
      await args.onAfterPrompt?.();
      completion = getAgentCompletion(args.agent);
      recoveryAttempts += 1;
    }

    if (containsLeakedInternalToolTranscript(completion.finalText)) {
      const cleaned = sanitizeAssistantText(completion.finalText);
      return {
        finalText: cleaned || INTERNAL_TOOL_TRANSCRIPT_FALLBACK_REPLY,
      };
    }

    return {
      ...completion,
      finalText: sanitizeAssistantText(completion.finalText),
    };
  } finally {
    try {
      await args.onCleanup?.();
    } finally {
      unsubscribe();
      args.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }
};
