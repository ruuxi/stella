import { useMemo, useDeferredValue } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { MessagePayload, ToolResultPayload } from "@/app/chat/lib/event-transforms";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
  getRunningTasks,
} from "@/app/chat/lib/event-transforms";
import { filterEventsForUiDisplay } from "@/app/chat/lib/message-display";
import { useDepseudonymize } from "@/app/chat/hooks/use-depseudonymize";
import { isOrchestratorChatMessagePayload } from "@/app/chat/emotes/message-source";
import {
  type TurnViewModel,
  getDisplayMessageText,
  getDisplayUserText,
  getAttachments,
  getChannelEnvelope,
} from "./MessageTurn";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";

type BaseTurnViewModel = Omit<TurnViewModel, "selfModApplied">;

const getTurnWebSearchHtml = (events: EventRecord[]): string | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== "tool_result" || !event.payload || typeof event.payload !== "object") {
      continue;
    }
    const payload = event.payload as ToolResultPayload;
    if (payload.toolName?.toLowerCase() !== "websearch") {
      continue;
    }
    if (typeof payload.html === "string" && payload.html.trim().length > 0) {
      return payload.html;
    }
    if (typeof payload.result === "string" && payload.result.trim().startsWith("<")) {
      return payload.result;
    }
  }
  return undefined;
};

const getMessagePayload = (event?: EventRecord): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== "object") {
    return null;
  }
  return event.payload as MessagePayload;
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
  const hasAssistantReply = useMemo(() => {
    if (!pendingUserMessageId) return false;
    return events.some(
      (event) =>
        event.type === "assistant_message" &&
        (event.payload as { userMessageId?: string } | null)
          ?.userMessageId === pendingUserMessageId,
    );
  }, [events, pendingUserMessageId]);

  const showStreaming = Boolean(
    (isStreaming || streamingText) && !hasAssistantReply,
  );

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

  const depseudonymize = useDepseudonymize();

  const baseTurns = useMemo(() => {
    return slicedTurns.map((turn): BaseTurnViewModel => {
      const userText = getDisplayUserText(turn.userMessage);
      const userAttachments = getAttachments(turn.userMessage);
      const userChannelEnvelope = getChannelEnvelope(turn.userMessage);
      const assistantText = turn.assistantMessage
        ? depseudonymize(getDisplayMessageText(turn.assistantMessage))
        : "";
      const assistantMessageId = turn.assistantMessage?._id ?? null;
      const assistantEmotesEnabled = isOrchestratorChatMessagePayload(
        getMessagePayload(turn.assistantMessage),
      );
      const webSearchBadgeHtml = getTurnWebSearchHtml(turn.toolEvents);

      return {
        id: turn.id,
        userText,
        userAttachments,
        userChannelEnvelope,
        assistantText,
        assistantMessageId,
        assistantEmotesEnabled,
        webSearchBadgeHtml,
      };
    });
  }, [slicedTurns, depseudonymize]);

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

  const deferredStreamingText = useDeferredValue(streamingText);
  const deferredReasoningText = useDeferredValue(reasoningText);

  const { processedStreamingText, processedReasoningText } = useMemo(
    () => ({
      processedStreamingText: deferredStreamingText
        ? depseudonymize(deferredStreamingText)
        : deferredStreamingText,
      processedReasoningText: deferredReasoningText
        ? depseudonymize(deferredReasoningText)
        : deferredReasoningText,
    }),
    [deferredStreamingText, deferredReasoningText, depseudonymize],
  );

  const { runningTool, runningTasks } = useMemo(
    () => ({
    runningTool: getCurrentRunningTool(events),
    runningTasks: getRunningTasks(events),
  }),
  [events],
  );

  const hasPendingTurn = useMemo(() => {
    if (!pendingUserMessageId) return false;
    return turns.some((turn) => turn.id === pendingUserMessageId);
  }, [turns, pendingUserMessageId]);

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




