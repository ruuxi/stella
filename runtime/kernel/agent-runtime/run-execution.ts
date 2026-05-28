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
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";

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

const DEFAULT_AGENT_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const configuredTimeoutMs = (
  envName: string,
  fallbackMs: number,
): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
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
  conversationId?: string;
  uiVisibility?: "visible" | "hidden";
  onAfterPrompt?: () => Promise<void> | void;
  onCleanup?: () => Promise<void> | void;
}): Promise<{ finalText: string; errorMessage?: string }> => {
  const abortHandler = () => args.agent.abort();
  args.abortSignal?.addEventListener("abort", abortHandler);

  const startupIdleTimeoutMs = configuredTimeoutMs(
    "STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS",
    DEFAULT_AGENT_STARTUP_IDLE_TIMEOUT_MS,
  );
  const idleTimeoutMs = configuredTimeoutMs(
    "STELLA_AGENT_IDLE_TIMEOUT_MS",
    DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleSettled = false;
  let hasAgentActivity = false;
  let rejectIdle: (error: Error) => void = () => {};
  const idleFailure = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  const refreshIdleTimer = () => {
    if (idleSettled) return;
    if (idleTimer) clearTimeout(idleTimer);
    const timeoutMs = hasAgentActivity ? idleTimeoutMs : startupIdleTimeoutMs;
    idleTimer = setTimeout(() => {
      idleSettled = true;
      try {
        args.agent.abort();
      } catch {
        // Best effort; the prompt race below owns surfacing the timeout.
      }
      rejectIdle(
        new Error(
          `Agent did not produce activity for ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    idleTimer.unref?.();
  };
  const markAgentActivity = () => {
    hasAgentActivity = true;
    refreshIdleTimer();
  };
  refreshIdleTimer();
  const unsubscribeIdle = args.agent.subscribe(() => markAgentActivity());

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
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
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
      if (
        messageType === "message" &&
        promptMessage.message.role === "runtimeInternal" &&
        promptInput.customType?.startsWith("bootstrap.") &&
        args.threadStore &&
        args.threadKey
      ) {
        persistThreadCustomMessage(args.threadStore, {
          threadKey: args.threadKey,
          customType: promptInput.customType,
          content: promptMessage.message.content,
          display: promptMessage.message.display === true,
          timestamp: promptMessage.message.timestamp,
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
    const promptPromise = args.agent.prompt(
      promptMessages.map((message) => message.message),
    );
    promptPromise.catch(() => undefined);
    await Promise.race([promptPromise, idleFailure]);
    await args.onAfterPrompt?.();
    const completion = getAgentCompletion(args.agent);

    return {
      ...completion,
      finalText: completion.finalText.trim(),
    };
  } finally {
    idleSettled = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      await args.onCleanup?.();
    } finally {
      unsubscribeIdle();
      unsubscribe();
      args.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }
};
