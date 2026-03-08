/**
 * Hook that captures agent IPC stream events and conversation events
 * into the global trace store. Runs independently of the streaming chat
 * hook — captures ALL events without runId filtering, so sub-agent
 * tool calls and lifecycle events are visible.
 */

import { useEffect, useRef } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import {
  isTaskStarted,
  isTaskCompleted,
  isTaskFailed,
  isTaskProgress,
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
  traceTaskFailed,
  traceTaskProgress,
  traceUserMessage,
  traceAssistantMessage,
  registerRunAgent,
  addTrace,
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
      switch (event.type) {
        case "tool-start":
          traceToolStart(
            event.toolName ?? "unknown",
            event.toolCallId,
            event.runId,
          );
          break;
        case "tool-end":
          traceToolEnd(
            event.toolName ?? "unknown",
            event.toolCallId,
            event.resultPreview,
            event.runId,
          );
          break;
        case "error":
          traceAgentError(
            event.error ?? "unknown error",
            event.fatal ?? false,
            event.runId,
          );
          break;
        case "end":
          traceStreamEnd(
            event.runId,
            (event.finalText ?? "").slice(0, 200),
          );
          break;
        case "task-started":
          traceTaskStarted(
            event.taskId ?? "unknown",
            event.agentType ?? "unknown",
            event.description ?? "",
            event.parentTaskId,
          );
          break;
        case "task-completed":
          traceTaskCompleted(event.taskId ?? "unknown", event.result);
          break;
        case "task-failed":
          traceTaskFailed(event.taskId ?? "unknown", event.error);
          break;
        case "task-progress":
          traceTaskProgress(event.taskId ?? "unknown", event.statusText ?? "");
          break;
        // "stream" events are high-frequency text deltas — skip for trace
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
export function useTraceEventMonitor(
  enabled: boolean,
  events: EventRecord[],
) {
  const seenIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;

    const seen = seenIdsRef.current;

    for (const event of events) {
      if (seen.has(event._id)) continue;
      seen.add(event._id);

      if (isTaskStarted(event)) {
        const p = event.payload;
        traceTaskStarted(
          p.taskId,
          p.agentType,
          p.description,
          p.parentTaskId,
        );
        continue;
      }

      if (isTaskCompleted(event)) {
        traceTaskCompleted(event.payload.taskId, event.payload.result);
        continue;
      }

      if (isTaskFailed(event)) {
        traceTaskFailed(event.payload.taskId, event.payload.error);
        continue;
      }

      if (isTaskProgress(event)) {
        traceTaskProgress(event.payload.taskId, event.payload.statusText);
        continue;
      }

      if (isToolRequest(event)) {
        const p = event.payload;
        // Only trace if it has agentType (sub-agent tool use) to avoid
        // duplicating the IPC tool-start events from the orchestrator
        if (p.agentType) {
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
          addTrace("error", "tool-error", `${p.toolName}: ${p.error.slice(0, 200)}`, {
            toolName: p.toolName,
            data: { error: p.error },
          });
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

/**
 * Registers the orchestrator's runId so trace entries can label the agent.
 */
export function useTraceRunRegistration(runId: string | null) {
  useEffect(() => {
    if (runId) {
      registerRunAgent(runId, "orchestrator");
    }
  }, [runId]);
}
