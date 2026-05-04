/**
 * Hook that captures agent IPC stream events and conversation events
 * into the global trace store. Runs independently of the streaming chat
 * hook â€” captures ALL events without runId filtering, so sub-agent
 * tool calls and lifecycle events are visible.
 */

import { useEffect, useRef } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import {
  AGENT_IDS,
  AGENT_STREAM_EVENT_TYPES,
} from "../../../../runtime/contracts/agent-runtime.js";
import {
  isAgentStartedEvent,
  isAgentCompletedEvent,
  isAgentCanceledEvent,
  isAgentFailedEvent,
  isAgentProgressEvent,
  isToolRequest,
  isToolResult,
  isUserMessage,
  isAssistantMessage,
  getEventText,
} from "@/app/chat/lib/event-transforms";
import {
  traceToolStart,
  traceToolEnd,
  traceAgentError,
  traceStreamEnd,
  traceTaskStarted,
  traceTaskCompleted,
  traceTaskCanceled,
  traceTaskFailed,
  traceTaskProgress,
  traceUserMessage,
  traceAssistantMessage,
  registerRunAgent,
  addTrace,
  formatTraceSnippet,
} from "@/debug/trace-store";

/**
 * Persistent IPC listener that captures all agent stream events
 * into the trace store. Unlike handleAgentEvent in use-streaming-chat,
 * this does NOT filter by runId, so sub-agent events are captured.
 */
export function useTraceIpcListener(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !window.electronAPI?.agent?.onStream) return;

    const cleanup = window.electronAPI.agent.onStream((event) => {
      if (event.agentType) {
        registerRunAgent(event.runId, event.agentType);
      }

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.TOOL_START:
          traceToolStart(
            event.toolName ?? "unknown",
            event.toolCallId,
            event.runId,
            event.args,
          );
          break;
        case AGENT_STREAM_EVENT_TYPES.TOOL_END:
          traceToolEnd(
            event.toolName ?? "unknown",
            event.toolCallId,
            event.resultPreview,
            event.runId,
          );
          break;
        case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED:
          if (event.outcome === "error") {
            traceAgentError(
              event.error ?? event.reason ?? "unknown error",
              true,
              event.runId,
            );
          } else {
            traceStreamEnd(
              event.runId,
              `${event.outcome ?? "completed"} ${(event.finalText ?? "").slice(0, 160)}`.trim(),
            );
          }
          break;
        case AGENT_STREAM_EVENT_TYPES.AGENT_STARTED:
          traceTaskStarted(
            event.agentId ?? "unknown",
            event.agentType ?? "unknown",
            event.description ?? "",
            event.parentAgentId,
          );
          break;
        case AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED:
          traceTaskCompleted(event.agentId ?? "unknown", event.result);
          break;
        case AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED:
          traceTaskCanceled(event.agentId ?? "unknown", event.error);
          break;
        case AGENT_STREAM_EVENT_TYPES.AGENT_FAILED:
          traceTaskFailed(event.agentId ?? "unknown", event.error);
          break;
        case AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS:
          traceTaskProgress(event.agentId ?? "unknown", event.statusText ?? "");
          break;
        // "stream" events are high-frequency text deltas â€” skip for trace
      }
    });

    addTrace("system", "trace-listener-attached", "IPC trace listener started");

    return () => {
      cleanup();
    };
  }, [enabled]);
}

/**
 * Monitors the conversation event feed and emits trace entries for
 * task lifecycle events (sub-agent delegation), tool requests/results
 * from persisted events, and message flow.
 */
export function useTraceEventMonitor(enabled: boolean, events: EventRecord[]) {
  const seenIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;

    const seen = seenIdsRef.current;

    for (const event of events) {
      if (seen.has(event._id)) continue;
      seen.add(event._id);

      if (isAgentStartedEvent(event)) {
        const p = event.payload;
        traceTaskStarted(p.agentId, p.agentType, p.description, p.parentAgentId);
        continue;
      }

      if (isAgentCompletedEvent(event)) {
        traceTaskCompleted(event.payload.agentId, event.payload.result);
        continue;
      }

      if (isAgentFailedEvent(event)) {
        traceTaskFailed(event.payload.agentId, event.payload.error);
        continue;
      }

      if (isAgentCanceledEvent(event)) {
        traceTaskCanceled(event.payload.agentId, event.payload.error);
        continue;
      }

      if (isAgentProgressEvent(event)) {
        traceTaskProgress(event.payload.agentId, event.payload.statusText);
        continue;
      }

      if (isToolRequest(event)) {
        const p = event.payload;
        // Only trace if it has agentType (sub-agent tool use) to avoid
        // duplicating the IPC tool-start events from the orchestrator
        if (p.agentType && p.agentType !== AGENT_IDS.ORCHESTRATOR) {
          addTrace("tool", "tool-request", `[${p.agentType}] ${p.toolName}`, {
            toolName: p.toolName,
            agent: p.agentType,
            data: p.args ? { args: p.args } : undefined,
          });
        }
        continue;
      }

      if (isToolResult(event)) {
        const p = event.payload;
        if (p.error) {
          addTrace(
            "error",
            "tool-error",
            `${p.toolName}: ${formatTraceSnippet(p.error, 200)}`,
            {
              toolName: p.toolName,
              agent: p.agentType,
              data: { error: p.error },
            },
          );
        }
        continue;
      }

      if (isUserMessage(event)) {
        traceUserMessage(getEventText(event), event._id);
        continue;
      }

      if (isAssistantMessage(event)) {
        traceAssistantMessage(getEventText(event), event._id);
        continue;
      }
    }
  }, [enabled, events]);

  // Reset seen set when events array shrinks (new conversation)
  useEffect(() => {
    if (events.length === 0) {
      seenIdsRef.current.clear();
    }
  }, [events.length]);
}
