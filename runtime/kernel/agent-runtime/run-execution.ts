import type { AgentEvent, AgentMessage } from "../agent-core/types.js";
import { Buffer } from "node:buffer";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import {
  subscribeRuntimeAgentEvents,
  type RuntimeRunEventRecorder,
} from "./run-events.js";
import {
  createRuntimePromptAgentMessage,
  prepareRuntimeAttachments,
} from "./run-preparation.js";
import {
  enrichImageContentForTextOnlyModel,
  IMAGE_DESCRIPTION_CUSTOM_TYPE,
  type ImageDescriptionService,
} from "./image-description.js";
import { getAgentCompletion, now } from "./shared.js";
import type { RuntimeRunCallbacks } from "./types.js";
import {
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";

type RuntimeExecutableAgent = {
  state: {
    messages: AgentMessage[];
    model?: {
      provider?: string;
      api?: string;
      id?: string;
      input?: ("text" | "image")[];
    };
  };
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  prompt: (message: AgentMessage | AgentMessage[]) => Promise<void>;
  followUp: (message: AgentMessage) => void;
  continue: () => Promise<void>;
  abort: () => void;
};

const DEFAULT_AGENT_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Ceiling while tool calls are in flight. Deliberately above the agent-core
// per-tool inactivity bound (10 min) so the tool-level cancellation — which
// fails only the tool and lets the agent continue — always wins when tool
// tracking is intact. This run-killing backstop fires only when tracking
// leaked (e.g. a lost tool_execution_end).
const DEFAULT_AGENT_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const AGENT_ABORT_SETTLE_GRACE_MS = 100;

const configuredTimeoutMs = (
  envName: string,
  fallbackMs: number,
): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

const waitForAgentAbortSettlement = async (
  work: Promise<void>,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, AGENT_ABORT_SETTLE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

const attachmentMimeType = (attachment: RuntimeAttachmentRef): string =>
  attachment.mimeType?.trim().toLowerCase() ?? "";

const isRemoteImageAttachment = (attachment: RuntimeAttachmentRef): boolean =>
  /^https?:\/\//i.test(attachment.url) &&
  (attachmentMimeType(attachment).startsWith("image/") ||
    attachment.kind?.toLowerCase() === "image");

const materializeRemoteImageAttachment = async (
  attachment: RuntimeAttachmentRef,
): Promise<RuntimeAttachmentRef> => {
  if (!isRemoteImageAttachment(attachment)) return attachment;
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) return attachment;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) return attachment;
    const mimeType =
      attachmentMimeType(attachment) ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ||
      "";
    if (!mimeType.startsWith("image/")) return attachment;
    return {
      ...attachment,
      mimeType,
      url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  } catch {
    return attachment;
  }
};

const materializePromptAttachments = async (
  attachments?: RuntimeAttachmentRef[],
  target?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): Promise<RuntimeAttachmentRef[] | undefined> => {
  if (!attachments?.length) return attachments;
  const materialized = await Promise.all(
    attachments.map(materializeRemoteImageAttachment),
  );
  return await prepareRuntimeAttachments(materialized, target);
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
  attemptGeneration?: number;
  stellaDataDir?: string;
  describeImages?: ImageDescriptionService;
  afterDurableMessagePersisted?: (
    payload: import("../storage/shared.js").PersistedRuntimeThreadPayload,
  ) => void;
  /**
   * Resume the agent loop from its existing in-memory context instead of
   * appending a new prompt. Used by the safety model-swap retry: the failed
   * attempt's prompt is already in context (and persisted), so re-prompting
   * would duplicate it. Requires the context's last message to not be an
   * assistant message (callers pop the errored assistant before resuming).
   */
  resume?: boolean;
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
  const toolIdleTimeoutMs = configuredTimeoutMs(
    "STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS",
    DEFAULT_AGENT_TOOL_IDLE_TIMEOUT_MS,
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleSettled = false;
  let hasAgentActivity = false;
  const activeToolCallIds = new Set<string>();
  let rejectIdle: (error: Error) => void = () => {};
  const idleFailure = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  const refreshIdleTimer = () => {
    if (idleSettled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    // A tool owns its own completion/cancellation semantics. Long-running
    // commands can legitimately be silent for more than the agent stream's
    // idle window, so while tool calls are in flight the watchdog is armed
    // with the much longer tool ceiling instead of the stream idle window.
    // The agent-core per-tool inactivity bound cancels a silent tool (with
    // an error result the agent survives) well before this fires; reaching
    // this timeout means tool tracking leaked and the run really is dead.
    const toolsInFlight = activeToolCallIds.size > 0;
    const timeoutMs = toolsInFlight
      ? toolIdleTimeoutMs
      : hasAgentActivity
        ? idleTimeoutMs
        : startupIdleTimeoutMs;
    idleTimer = setTimeout(() => {
      idleSettled = true;
      try {
        args.agent.abort();
      } catch {
        // Best effort; the prompt race below owns surfacing the timeout.
      }
      rejectIdle(
        new Error(
          toolsInFlight
            ? `Agent produced no activity for ${Math.round(timeoutMs / 1000)}s while ${activeToolCallIds.size} tool call(s) were still marked in flight.`
            : `Agent did not produce activity for ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    idleTimer.unref?.();
  };
  const markAgentActivity = (event?: AgentEvent) => {
    hasAgentActivity = true;
    if (event?.type === "tool_execution_start") {
      activeToolCallIds.add(event.toolCallId);
    } else if (event?.type === "tool_execution_end") {
      activeToolCallIds.delete(event.toolCallId);
    }
    refreshIdleTimer();
  };
  refreshIdleTimer();
  const unsubscribeIdle = args.agent.subscribe(markAgentActivity);

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
    ...(typeof args.attemptGeneration === "number"
      ? { attemptGeneration: args.attemptGeneration }
      : {}),
    ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
    ...(args.afterDurableMessagePersisted
      ? { afterDurableMessagePersisted: args.afterDurableMessagePersisted }
      : {}),
  });

  try {
    if (args.resume) {
      const continuePromise = args.agent.continue();
      continuePromise.catch(() => undefined);
      try {
        await Promise.race([continuePromise, idleFailure]);
      } catch (error) {
        // When the watchdog aborts the Agent, wait for its loop to append the
        // terminal errored assistant before returning control to run-level
        // retry preparation. Otherwise a retry can race the still-settling
        // attempt and resume on an assistant tail.
        await waitForAgentAbortSettlement(continuePromise);
        throw error;
      }
      await args.onAfterPrompt?.();
      const completion = getAgentCompletion(args.agent);
      return {
        ...completion,
        finalText: completion.finalText.trim(),
      };
    }
    const imageTarget = args.agent.state.model
      ? {
          provider: args.agent.state.model.provider,
          api: args.agent.state.model.api,
          modelId: args.agent.state.model.id,
        }
      : undefined;
    const promptInputs =
      args.promptMessages && args.promptMessages.length > 0
        ? await Promise.all(
            args.promptMessages.map(async (message) => ({
              ...message,
              attachments: await materializePromptAttachments(
                message.attachments,
                imageTarget,
              ),
            })),
          )
        : [
            {
              text: args.promptText ?? "",
              attachments: await materializePromptAttachments(
                args.attachments,
                imageTarget,
              ),
            },
          ];
    const promptTimestamp = now();
    const promptMessages = (
      await Promise.all(
        promptInputs.map(async (input, index) => {
          const message = createRuntimePromptAgentMessage(
            input,
            promptTimestamp + index * 2,
          );
          if (
            (message.role !== "user" && message.role !== "runtimeInternal") ||
            typeof message.content === "string"
          ) {
            return [{ message, input }];
          }
          const enrichedContent = await enrichImageContentForTextOnlyModel({
            content: message.content,
            model: args.agent.state.model,
            describeImages: args.describeImages,
            signal: args.abortSignal,
          });
          if (enrichedContent === message.content) {
            return [{ message, input }];
          }
          const description = enrichedContent.at(-1);
          if (description?.type !== "text") {
            return [{ message, input }];
          }
          const descriptionInput = {
            text: description.text,
            messageType: "message" as const,
            customType: IMAGE_DESCRIPTION_CUSTOM_TYPE,
            display: false,
            uiVisibility: "hidden" as const,
          };
          return [
            { message, input },
            {
              message: createRuntimePromptAgentMessage(
                descriptionInput,
                promptTimestamp + index * 2 + 1,
              ),
              input: descriptionInput,
            },
          ];
        }),
      )
    ).flat();
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
        (promptInput.customType?.startsWith("bootstrap.") ||
          promptInput.customType === IMAGE_DESCRIPTION_CUSTOM_TYPE) &&
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
    try {
      await Promise.race([promptPromise, idleFailure]);
    } catch (error) {
      // See the resume branch above: retry fencing needs the aborted Agent
      // loop fully settled before inspecting and removing its error tail.
      await waitForAgentAbortSettlement(promptPromise);
      throw error;
    }
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
