import { useMemo, useDeferredValue } from "react";
import type { EventRecord } from "../../hooks/use-conversation-events";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
  getRunningTasks,
} from "../../hooks/use-conversation-events";
import { useDepseudonymize } from "../../hooks/use-depseudonymize";
import {
  type TurnViewModel,
  getEventText,
  getAttachments,
} from "./MessageTurn";

export function useTurnViewModels(opts: {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
}) {
  const {
    events,
    maxItems,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
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

  const allTurns = useMemo(() => groupEventsIntoTurns(events), [events]);

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

  const turns = useMemo(() => {
    return slicedTurns.map((turn): TurnViewModel => {
      const userText = getEventText(turn.userMessage);
      const userAttachments = getAttachments(turn.userMessage);
      const assistantText = turn.assistantMessage
        ? depseudonymize(getEventText(turn.assistantMessage))
        : "";
      const assistantMessageId = turn.assistantMessage?._id ?? null;

      return {
        id: turn.id,
        userText,
        userAttachments,
        assistantText,
        assistantMessageId,
      };
    });
  }, [slicedTurns, depseudonymize]);

  const deferredStreamingText = useDeferredValue(streamingText);
  const deferredReasoningText = useDeferredValue(reasoningText);

  const processedStreamingText = useMemo(
    () =>
      deferredStreamingText
        ? depseudonymize(deferredStreamingText)
        : deferredStreamingText,
    [deferredStreamingText, depseudonymize],
  );
  const processedReasoningText = useMemo(
    () =>
      deferredReasoningText
        ? depseudonymize(deferredReasoningText)
        : deferredReasoningText,
    [deferredReasoningText, depseudonymize],
  );

  const runningTool = useMemo(
    () => getCurrentRunningTool(events),
    [events],
  );
  const runningTasks = useMemo(() => getRunningTasks(events), [events]);

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
