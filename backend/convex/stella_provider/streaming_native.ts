/**
 * Native (Pi-style) `AssistantMessageEvent` SSE translator.
 *
 * Stella's runtime client speaks this format directly, so the
 * server-side stream just adapts the runtime events into the
 * over-the-wire shape (`StellaAssistantMessageEventPayload`) without
 * the OpenAI delta/tool-call ceremony.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getCorsHeaders } from "../http_shared/cors";
import {
  buildManagedModel,
  completeManagedChat,
  streamManagedChat,
  type ManagedProtocol,
} from "../runtime_ai/managed";
import type { AssistantMessageEvent, Context } from "../runtime_ai/types";
import {
  scheduleAnonymousUsageRecord,
  toManagedBillingUsage,
  type AnonymousUsageRecord,
  type TokenEstimate,
} from "./billing";
import { buildManagedRuntimeRequestFromNativeRequest } from "./request";
import {
  SSE_HEARTBEAT_COMMENT,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_STREAM_OPEN_COMMENT,
  type ResolvedManagedServerModelConfig,
} from "./shared";

export type StellaAssistantMessageEventPayload =
  | { type: "start"; api: ManagedProtocol; provider: string; model: string }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | {
      type: "text_end";
      contentIndex: number;
      content?: string;
      contentSignature?: string;
    }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "thinking_end";
      contentIndex: number;
      content?: string;
      contentSignature?: string;
    }
  | {
      type: "toolcall_start";
      contentIndex: number;
      id: string;
      toolName: string;
    }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | {
      type: "done";
      reason: Extract<AssistantMessageEvent["type"], "done"> extends never
        ? never
        : "stop" | "length" | "toolUse";
      usage: Awaited<ReturnType<typeof completeManagedChat>>["usage"];
    }
  | {
      type: "error";
      reason: "aborted" | "error";
      errorMessage?: string;
      usage: Awaited<ReturnType<typeof completeManagedChat>>["usage"];
    };

export function mapAssistantEventToStellaEvent(args: {
  event: AssistantMessageEvent;
  partialModel: ReturnType<typeof buildManagedModel>;
}): StellaAssistantMessageEventPayload | null {
  const { event, partialModel } = args;

  switch (event.type) {
    case "start":
      return {
        type: "start",
        api: partialModel.api,
        provider: partialModel.provider,
        model: partialModel.id,
      };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta":
      return {
        type: "text_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "text_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        content: event.content,
        contentSignature:
          content && content.type === "text"
            ? content.textSignature
            : undefined,
      };
    }
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return {
        type: "thinking_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "thinking_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        content:
          content && content.type === "thinking"
            ? content.thinking
            : event.content,
        contentSignature:
          content && content.type === "thinking"
            ? content.thinkingSignature
            : undefined,
      };
    }
    case "toolcall_start": {
      const toolCall = event.partial.content[event.contentIndex];
      if (!toolCall || toolCall.type !== "toolCall") {
        return null;
      }
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        id: toolCall.id,
        toolName: toolCall.name,
      };
    }
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: event.contentIndex };
    case "done":
      return {
        type: "done",
        reason: event.reason,
        usage: event.message.usage,
      };
    case "error":
      return {
        type: "error",
        reason: event.reason,
        errorMessage: event.error.errorMessage,
        usage: event.error.usage,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export async function createNativeRuntimeResponse(args: {
  request: Request;
  ctx: ActionCtx;
  ownerId: string;
  agentType: string;
  modelId: string;
  tokenEstimate: TokenEstimate;
  context: Context;
  nativeRequest: Record<string, unknown> | null;
  managedApi: ManagedProtocol;
  serverModelConfig: ResolvedManagedServerModelConfig;
  fallbackModelConfig?: ResolvedManagedServerModelConfig;
  anonymousUsageRecord?: AnonymousUsageRecord;
}): Promise<Response> {
  const {
    request,
    ctx,
    ownerId,
    agentType,
    modelId,
    tokenEstimate,
    context,
    nativeRequest,
    managedApi,
    serverModelConfig,
    fallbackModelConfig,
    anonymousUsageRecord,
  } = args;
  const origin = request.headers.get("origin");
  const requestStartedAt = Date.now();
  const encoder = new TextEncoder();
  const managedModel = buildManagedModel(serverModelConfig, managedApi);
  const responseHeaders: Record<string, string> = {
    ...getCorsHeaders(origin),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
  };

  const sendEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: StellaAssistantMessageEventPayload,
  ) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastDownstreamWriteAt = Date.now();
      let closed = false;

      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        request.signal.removeEventListener("abort", onClientAbort);
      };

      const enqueueComment = (chunk: Uint8Array) => {
        if (closed) return;
        controller.enqueue(chunk);
        lastDownstreamWriteAt = Date.now();
      };

      const onClientAbort = () => {
        try {
          controller.close();
        } catch {
          // Ignore double-close races with the runtime loop.
        } finally {
          closeStream();
        }
      };

      const heartbeatTimer = setInterval(() => {
        if (closed) {
          clearInterval(heartbeatTimer);
          return;
        }
        if (Date.now() - lastDownstreamWriteAt >= SSE_HEARTBEAT_INTERVAL_MS) {
          try {
            enqueueComment(SSE_HEARTBEAT_COMMENT);
          } catch {
            closeStream();
          }
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener("abort", onClientAbort, { once: true });
      enqueueComment(SSE_STREAM_OPEN_COMMENT);

      const runtimeStream = streamManagedChat({
        config: serverModelConfig,
        fallbackConfig: fallbackModelConfig,
        context,
        api: managedApi,
        request: buildManagedRuntimeRequestFromNativeRequest(
          nativeRequest,
          request.signal,
        ),
      });
      const iterator = runtimeStream[Symbol.asyncIterator]();
      let didRecordAnonymousUsage = false;

      const handleRuntimeEvent = async (event: AssistantMessageEvent) => {
        const payload = mapAssistantEventToStellaEvent({
          event,
          partialModel: managedModel,
        });
        if (payload) {
          sendEvent(controller, payload);
          lastDownstreamWriteAt = Date.now();
        }

        if (event.type === "done") {
          const executedModel = event.message.model || modelId;
          const fallbackUsed = executedModel !== managedModel.id;
          console.log(
            `[stella-provider] completed agent=${agentType} | requestedModel=${modelId} | primaryModel=${managedModel.id} | model=${executedModel} | fallbackUsed=${fallbackUsed}`,
          );
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: executedModel,
            durationMs: Date.now() - requestStartedAt,
            success: true,
            ...toManagedBillingUsage(event.message, tokenEstimate),
          });
          if (!didRecordAnonymousUsage) {
            didRecordAnonymousUsage = true;
            await scheduleAnonymousUsageRecord(ctx, anonymousUsageRecord);
          }
          if (!closed) {
            controller.close();
          }
          return true;
        }

        if (event.type === "error") {
          console.error(
            "[stella-provider] Native streaming error:",
            event.error.errorMessage || "Streaming completion failed",
          );
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: modelId,
            durationMs: Date.now() - requestStartedAt,
            success: false,
            inputTokens: tokenEstimate.inputTokens,
            outputTokens: tokenEstimate.outputTokens,
          });
          if (!closed) {
            controller.close();
          }
          return true;
        }

        return false;
      };

      void (async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            if (await handleRuntimeEvent(next.value)) {
              return;
            }
          }
          if (!closed) {
            controller.close();
          }
        } catch (error) {
          console.error("[stella-provider] Native streaming error:", error);
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: modelId,
            durationMs: Date.now() - requestStartedAt,
            success: false,
            inputTokens: tokenEstimate.inputTokens,
            outputTokens: tokenEstimate.outputTokens,
          });
          if (!closed && !request.signal.aborted) {
            sendEvent(controller, {
              type: "error",
              reason: "error",
              errorMessage: "Failed to generate Stella completion",
              usage: {
                input: tokenEstimate.inputTokens,
                output: tokenEstimate.outputTokens,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens:
                  tokenEstimate.inputTokens + tokenEstimate.outputTokens,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            });
            controller.close();
          }
        } finally {
          closeStream();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: responseHeaders,
  });
}
