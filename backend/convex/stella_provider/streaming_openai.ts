/**
 * OpenAI-compatible Server-Sent Events translator.
 *
 * Maps the runtime `AssistantMessageEvent` stream into the
 * `chat.completion.chunk` SSE shape OpenAI clients expect, so the
 * Stella provider can be dropped into any OpenAI-compatible chat UI
 * unchanged. The native (Pi-style) variant lives in
 * `streaming_native.ts`.
 *
 * Heartbeat + abort wiring is intentionally local to each streamer
 * (rather than DRY-d into a shared helper) so each variant can pick
 * its own framing and termination semantics without trampling the
 * other.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getCorsHeaders } from "../http_shared/cors";
import {
  buildContextFromChatMessages,
  buildManagedModel,
  streamManagedChat,
  usageSummaryFromAssistant,
  type ManagedProtocol,
} from "../runtime_ai/managed";
import type { AssistantMessageEvent } from "../runtime_ai/types";
import {
  mapStopReason,
  toManagedBillingUsage,
  toOpenAIUsage,
  type TokenEstimate,
} from "./billing";
import { buildManagedRuntimeRequest } from "./request";
import type {
  ResolvedManagedServerModelConfig,
  StellaRequestBody,
} from "./shared";
import {
  SSE_HEARTBEAT_COMMENT,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_STREAM_OPEN_COMMENT,
} from "./shared";

export function buildStreamingErrorPayload(args: {
  id: string;
  created: number;
  model: string;
  message: string;
}) {
  return {
    id: args.id,
    object: "chat.completion.chunk",
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "error",
      },
    ],
    error: {
      message: args.message,
      type: "server_error",
    },
  };
}

export async function createStreamingRuntimeResponse(args: {
  request: Request;
  ctx: ActionCtx;
  ownerId: string;
  agentType: string;
  modelId: string;
  tokenEstimate: TokenEstimate;
  requestBody: StellaRequestBody;
  managedApi: ManagedProtocol;
  serverModelConfig: ResolvedManagedServerModelConfig;
  fallbackModelConfig?: ResolvedManagedServerModelConfig;
}): Promise<Response> {
  const {
    request,
    ctx,
    ownerId,
    agentType,
    modelId,
    tokenEstimate,
    requestBody,
    managedApi,
    serverModelConfig,
    fallbackModelConfig,
  } = args;
  const origin = request.headers.get("origin");
  const responseHeaders: Record<string, string> = {
    ...getCorsHeaders(origin),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
  };
  const requestStartedAt = Date.now();
  const responseId = `chatcmpl_${requestStartedAt}`;
  const created = Math.floor(requestStartedAt / 1000);
  const encoder = new TextEncoder();
  const primaryManagedModel = buildManagedModel(serverModelConfig, managedApi);

  const sendChunk = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: unknown,
  ) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastDownstreamWriteAt = Date.now();
      let closed = false;
      let nextToolIndex = 0;
      const toolIndexByContentIndex = new Map<number, number>();

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
        context: buildContextFromChatMessages(
          requestBody.messages,
          requestBody.tools,
        ),
        api: managedApi,
        request: buildManagedRuntimeRequest(requestBody, request.signal),
      });
      const iterator = runtimeStream[Symbol.asyncIterator]();

      const handleRuntimeEvent = async (event: AssistantMessageEvent) => {
        if (event.type === "text_delta") {
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { content: event.delta },
              },
            ],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "thinking_delta") {
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: event.delta },
              },
            ],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "thinking_end") {
          const partial = event.partial.content[event.contentIndex];
          if (
            partial &&
            partial.type === "thinking" &&
            typeof partial.thinkingSignature === "string" &&
            partial.thinkingSignature.trim().startsWith("{")
          ) {
            sendChunk(controller, {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_signature: partial.thinkingSignature },
                },
              ],
            });
            lastDownstreamWriteAt = Date.now();
          }
          return false;
        }

        if (
          event.type === "toolcall_start" ||
          event.type === "toolcall_delta"
        ) {
          const partial = event.partial.content[event.contentIndex];
          if (!partial || partial.type !== "toolCall") {
            return false;
          }

          const toolIndex =
            toolIndexByContentIndex.get(event.contentIndex) ?? nextToolIndex++;
          toolIndexByContentIndex.set(event.contentIndex, toolIndex);
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: partial.id,
                      type: "function",
                      function: {
                        name: partial.name,
                        arguments:
                          event.type === "toolcall_delta" ? event.delta : "",
                      },
                    },
                  ],
                },
              },
            ],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "done") {
          const usage = usageSummaryFromAssistant(event.message);
          const executedModel = event.message.model || modelId;
          const fallbackUsed = executedModel !== primaryManagedModel.id;
          console.log(
            `[stella-provider] completed agent=${agentType} | requestedModel=${modelId} | primaryModel=${primaryManagedModel.id} | model=${executedModel} | fallbackUsed=${fallbackUsed}`,
          );
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: mapStopReason(event.message.stopReason),
              },
            ],
            usage: toOpenAIUsage({
              inputTokens: usage?.inputTokens ?? tokenEstimate.inputTokens,
              outputTokens: usage?.outputTokens ?? tokenEstimate.outputTokens,
              totalTokens: usage?.totalTokens,
              cachedInputTokens: usage?.cachedInputTokens,
              reasoningTokens: usage?.reasoningTokens,
            }),
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: executedModel,
            durationMs: Date.now() - requestStartedAt,
            success: true,
            ...toManagedBillingUsage(event.message, tokenEstimate),
          });
          if (!closed) {
            controller.close();
          }
          return true;
        }

        if (event.type === "error") {
          const errorMessage =
            event.error.errorMessage || "Streaming completion failed";
          console.error("[stella-provider] Streaming error:", errorMessage);
          sendChunk(
            controller,
            buildStreamingErrorPayload({
              id: responseId,
              created,
              model: modelId,
              message: errorMessage,
            }),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
          console.error("[stella-provider] Streaming error:", error);
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
            sendChunk(
              controller,
              buildStreamingErrorPayload({
                id: responseId,
                created,
                model: modelId,
                message: "Failed to generate Stella completion",
              }),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
