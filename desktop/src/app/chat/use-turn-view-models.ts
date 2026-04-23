import { useMemo } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { MessagePayload } from "@/app/chat/lib/event-transforms";
import { isOfficePreviewRef } from "@/shared/contracts/office-preview";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
  getRunningTasks,
} from "@/app/chat/lib/event-transforms";
import { deriveTurnResource } from "@/app/chat/lib/derive-turn-resource";
import { filterEventsForUiDisplay } from "@/app/chat/lib/message-display";
import { useAgentSessionStartedAt } from "@/app/chat/hooks/use-agent-session-started-at";
import { isOrchestratorChatMessagePayload } from "@/app/chat/emotes/message-source";
import {
  type TurnViewModel,
  getDisplayMessageText,
  getDisplayUserText,
  getAttachments,
  getChannelEnvelope,
} from "./MessageTurn";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import {
  parseAskQuestionArgs,
  type AskQuestionPayload,
} from "./AskQuestionBubble";

type BaseTurnViewModel = Omit<TurnViewModel, "selfModApplied">;

const getMessagePayload = (event?: EventRecord): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== "object") {
    return null;
  }
  return event.payload as MessagePayload;
};

const getAssistantAgentId = (event?: EventRecord): string | undefined => {
  const payload = getMessagePayload(event);
  const rt = (payload?.metadata as Record<string, unknown> | undefined)
    ?.runtime as Record<string, unknown> | undefined;
  const target = rt?.responseTarget as
    | { type: string; agentId?: string; terminalState?: string }
    | undefined;
  if (
    (target?.type === "agent_turn" || target?.type === "agent_terminal_notice")
    && typeof target.agentId === "string"
  ) {
    return target.agentId;
  }
  return undefined;
};

const getAssistantUserMessageId = (event?: EventRecord): string | undefined => {
  const payload = getMessagePayload(event);
  return typeof payload?.userMessageId === "string" && payload.userMessageId.trim().length > 0
    ? payload.userMessageId.trim()
    : undefined;
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

    if (payload.toolName.toLowerCase() !== "web") {
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

const getAskQuestionPayload = (
  events: EventRecord[],
): AskQuestionPayload | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "tool_request") {
      continue;
    }
    const payload = event.payload as
      | { toolName?: string; args?: unknown }
      | undefined;
    if (!payload || typeof payload.toolName !== "string") {
      continue;
    }
    if (payload.toolName !== "askQuestion") {
      continue;
    }
    const parsed = parseAskQuestionArgs(payload.args);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const getTurnCwd = (events: EventRecord[]): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "tool_request") {
      continue;
    }
    const payload = event.payload as { args?: unknown } | undefined;
    if (!payload?.args || typeof payload.args !== "object") {
      continue;
    }
    const args = payload.args as Record<string, unknown>;
    const cwd =
      asNonEmptyString(args.working_directory)
      ?? asNonEmptyString(args.workdir)
      ?? asNonEmptyString(args.cwd);
    if (cwd) {
      return cwd;
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
  const stickyTaskIdByTurnId = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of displayEvents) {
      if (event.type !== "assistant_message") {
        continue;
      }
      const agentId = getAssistantAgentId(event);
      if (!agentId) {
        continue;
      }
      const turnId = getAssistantUserMessageId(event) ?? event._id;
      if (!map.has(turnId)) {
        map.set(turnId, agentId);
      }
    }
    return map;
  }, [displayEvents]);

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
      const assistantEmotesEnabled = isOrchestratorChatMessagePayload(
        getMessagePayload(turn.assistantMessage),
      );
      const agentId =
        getAssistantAgentId(turn.assistantMessage)
        ?? stickyTaskIdByTurnId.get(turn.id);

      const askQuestionPayload = getAskQuestionPayload(turn.toolEvents);
      const resourcePayload = deriveTurnResource(
        turn.toolEvents,
        assistantText,
        getTurnCwd(turn.toolEvents),
      );

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
        assistantEmotesEnabled,
        webSearchBadgeHtml: getWebSearchBadgeHtml(turn.toolEvents),
        officePreviewRef: getOfficePreviewRef(turn.toolEvents),
        ...(resourcePayload ? { resourcePayload } : {}),
        ...(askQuestionPayload ? { askQuestion: askQuestionPayload } : {}),
        ...(agentId ? { agentId } : {}),
      };
    });
  }, [slicedTurns, stickyTaskIdByTurnId]);

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

  const processedStreamingText = streamingText;
  const processedReasoningText = reasoningText;

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

