import { useMemo } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { MessagePayload } from "@/app/chat/lib/event-transforms";
import { isOfficePreviewRef } from "@/shared/contracts/office-preview";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
  getRunningTasks,
} from "@/app/chat/lib/event-transforms";
import { filterEventsForUiDisplay } from "@/app/chat/lib/message-display";
import { useAgentSessionStartedAt } from "@/app/chat/hooks/use-agent-session-started-at";

import { sanitizeAssistantText } from "../../../runtime/kernel/internal-tool-transcript.js";
import {
  type TurnViewModel,
  getDisplayMessageText,
  getDisplayUserText,
  getAttachments,
  getChannelEnvelope,
} from "./MessageTurn";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";

type BaseTurnViewModel = Omit<TurnViewModel, "selfModApplied">;

const getMessagePayload = (event?: EventRecord): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== "object") {
    return null;
  }
  return event.payload as MessagePayload;
};

const getAssistantTaskId = (event?: EventRecord): string | undefined => {
  const payload = getMessagePayload(event);
  const rt = (payload?.metadata as Record<string, unknown> | undefined)
    ?.runtime as Record<string, unknown> | undefined;
  const target = rt?.responseTarget as
    | { type: string; taskId?: string }
    | undefined;
  if (target?.type === "task_turn" && typeof target.taskId === "string") {
    return target.taskId;
  }
  return undefined;
};

const getWebSearchBadgeHtml = (events: EventRecord[]): string | undefined => {
  for (const event of events) {
    if (event.type !== "tool_result") {
      continue;
    }

    const payload = event.payload as {
      toolName?: string;
      html?: unknown;
      result?: unknown;
    } | undefined;
    if (!payload || typeof payload.toolName !== "string") {
      continue;
    }

    if (payload.toolName.toLowerCase() !== "websearch") {
      continue;
    }

    if (typeof payload.html === "string" && payload.html.trim()) {
      return payload.html;
    }

    if (typeof payload.result === "string" && payload.result.trim()) {
      return payload.result;
    }
  }

  return undefined;
};

const getOfficePreviewRef = (events: EventRecord[]) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "tool_result") {
      continue;
    }

    const payload = event.payload as { officePreviewRef?: unknown } | undefined;
    if (isOfficePreviewRef(payload?.officePreviewRef)) {
      return payload.officePreviewRef;
    }
  }

  return undefined;
};

export function useTurnViewModels(opts: {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  selfModMap?: Record<string, SelfModAppliedData>;
}) {
  const {
    events,
    maxItems,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
  } = opts;

  // Check if the pending user message already has an assistant reply
  const hasAssistantReply = useMemo(
    () =>
      Boolean(
        pendingUserMessageId &&
          events.some(
            (event) =>
              event.type === "assistant_message" &&
              (event.payload as { userMessageId?: string } | null)
                ?.userMessageId === pendingUserMessageId,
          ),
      ),
    [events, pendingUserMessageId],
  );

  const showStreaming = Boolean(!hasAssistantReply && (isStreaming || streamingText));

  const maxTurns =
    typeof maxItems === "number" ? Math.max(0, Math.floor(maxItems)) : null;

  const displayEvents = useMemo(() => filterEventsForUiDisplay(events), [events]);
  const allTurns = useMemo(() => groupEventsIntoTurns(displayEvents), [displayEvents]);

  const slicedTurns = useMemo(() => {
    if (maxTurns === null) return allTurns;
    if (maxTurns <= 0) return [];

    const baseStart = Math.max(0, allTurns.length - maxTurns);
    if (!showStreaming || !pendingUserMessageId) {
      return allTurns.slice(baseStart);
    }

    const pendingIndex = allTurns.findIndex(
      (turn) => turn.id === pendingUserMessageId,
    );

    if (pendingIndex !== -1 && pendingIndex < baseStart) {
      const windowEnd = pendingIndex + 1;
      const windowStart = Math.max(0, windowEnd - maxTurns);
      return allTurns.slice(windowStart, windowEnd);
    }

    return allTurns.slice(baseStart);
  }, [allTurns, maxTurns, pendingUserMessageId, showStreaming]);

  const appSessionStartedAtMs = useAgentSessionStartedAt();

  const baseTurns = useMemo(() => {
    return slicedTurns.map((turn): BaseTurnViewModel => {
      const userText = getDisplayUserText(turn.userMessage);
      const contextMetadata = getMessagePayload(turn.userMessage)?.metadata?.context;
      const userWindowLabel = contextMetadata?.windowLabel;
      const userWindowPreviewImageUrl = contextMetadata?.windowPreviewImageUrl;
      const userAttachments = getAttachments(turn.userMessage);
      const userChannelEnvelope = getChannelEnvelope(turn.userMessage);
      const assistantText = turn.assistantMessage
        ? getDisplayMessageText(turn.assistantMessage)
        : "";
      const assistantMessageId = turn.assistantMessage?._id ?? null;
      const taskId = getAssistantTaskId(turn.assistantMessage);

      return {
        id: turn.id,
        userText,
        ...(typeof userWindowLabel === "string" && userWindowLabel.trim()
          ? { userWindowLabel: userWindowLabel.trim() }
          : {}),
        ...(typeof userWindowPreviewImageUrl === "string" && userWindowPreviewImageUrl.trim()
          ? { userWindowPreviewImageUrl: userWindowPreviewImageUrl.trim() }
          : {}),
        userAttachments,
        userChannelEnvelope,
        assistantText,
        assistantMessageId,
        webSearchBadgeHtml: getWebSearchBadgeHtml(turn.toolEvents),
        officePreviewRef: getOfficePreviewRef(turn.toolEvents),
        ...(taskId ? { taskId } : {}),
      };
    });
  }, [slicedTurns]);

  const turns = useMemo(() => {
    if (!selfModMap) {
      return baseTurns;
    }

    let hasAppliedSelfMod = false;
    const nextTurns = baseTurns.map((turn): TurnViewModel => {
      const selfModApplied = selfModMap[turn.id];
      if (!selfModApplied) {
        return turn;
      }
      hasAppliedSelfMod = true;
      return { ...turn, selfModApplied };
    });

    return hasAppliedSelfMod ? nextTurns : baseTurns;
  }, [baseTurns, selfModMap]);

  const processedStreamingText = useMemo(
    () =>
      streamingText
        ? sanitizeAssistantText(streamingText)
        : streamingText,
    [streamingText],
  );

  const processedReasoningText = useMemo(
    () =>
      reasoningText
        ? reasoningText
        : reasoningText,
    [reasoningText],
  );

  const runningTool = useMemo(() => getCurrentRunningTool(events), [events]);
  const runningTasks = useMemo(
    () => getRunningTasks(events, { appSessionStartedAtMs }),
    [appSessionStartedAtMs, events],
  );

  const hasPendingTurn = useMemo(
    () =>
      Boolean(
        pendingUserMessageId &&
          turns.some((turn) => turn.id === pendingUserMessageId),
      ),
    [turns, pendingUserMessageId],
  );

  const showStandaloneStreaming = Boolean(
    showStreaming && pendingUserMessageId && !hasPendingTurn,
  );

  return {
    turns,
    showStreaming,
    showStandaloneStreaming,
    processedStreamingText,
    processedReasoningText,
    runningTool,
    runningTasks,
  };
}


