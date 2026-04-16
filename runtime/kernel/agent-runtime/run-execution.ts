import type { AgentEvent, AgentMessage } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import {
  subscribeRuntimeAgentEvents,
  type RuntimeRunEventRecorder,
} from "./run-events.js";
import { createRuntimePromptAgentMessage } from "./run-preparation.js";
import {
  getAgentCompletion,
  now,
} from "./shared.js";
import type { RuntimeRunCallbacks } from "./types.js";
import {
  sanitizeAssistantText,
} from "../internal-tool-transcript.js";
import { persistThreadPayloadMessage } from "./thread-memory.js";

type RuntimeExecutableAgent = {
  state: {
    messages: AgentMessage[];
  };
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  prompt: (message: AgentMessage | AgentMessage[]) => Promise<void>;
  followUp: (message: AgentMessage) => void;
  continue: () => Promise<void>;
  abort: () => void;
};

export const executeRuntimeAgentPrompt = async (args: {
  agent: RuntimeExecutableAgent;
  promptText?: string;
  attachments?: RuntimeAttachmentRef[];
  promptMessages?: Array<
    RuntimePromptMessage & {
      attachments?: RuntimeAttachmentRef[];
    }
  >;
  runId: string;
  agentType: string;
  userMessageId: string;
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
      message: createRuntimePromptAgentMessage(
        message,
        promptTimestamp + index,
      ),
      input: message,
    }));
    for (const [index, promptMessage] of promptMessages.entries()) {
      const promptInput = promptMessage.input ?? promptInputs[index];
      const messageType = promptInput?.messageType ?? "user";
      if (
        messageType === "user" &&
        promptMessage.message.role === "user" &&
        args.threadStore &&
        args.threadKey
      ) {
        persistThreadPayloadMessage(args.threadStore, {
          threadKey: args.threadKey,
          payload: promptMessage.message,
        });
      }
      const uiVisibility = promptInput?.uiVisibility;
      if (messageType === "user" && uiVisibility) {
        args.callbacks?.onUserMessage?.({
          userMessageId: args.userMessageId,
          text: promptInput.text,
          timestamp: promptMessage.message.timestamp,
          uiVisibility,
        });
      }
    }
    await args.agent.prompt(promptMessages.map((message) => message.message));
    await args.onAfterPrompt?.();
    const completion = getAgentCompletion(args.agent);

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
