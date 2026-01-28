import { useState, useMemo } from "react";
import type { EventRecord, MessagePayload, Attachment } from "../hooks/use-conversation-events";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
} from "../hooks/use-conversation-events";
import { WorkingIndicator } from "../components/chat/WorkingIndicator";
import { Markdown } from "../components/chat/Markdown";
import { StepsContainer } from "../components/steps-container";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  isStreaming?: boolean;
  onOpenAttachment?: (attachment: Attachment) => void;
};

const getEventText = (event: EventRecord): string => {
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as MessagePayload;
    return payload.text ?? payload.content ?? payload.message ?? "";
  }
  return "";
};

const getAttachments = (event: EventRecord): Attachment[] => {
  if (event.payload && typeof event.payload === "object") {
    return (event.payload as MessagePayload).attachments ?? [];
  }
  return [];
};

export const ConversationEvents = ({
  events,
  maxItems,
  streamingText,
  isStreaming,
  onOpenAttachment,
}: Props) => {
  const visible = maxItems ? events.slice(-maxItems) : events;
  const showStreaming = Boolean(isStreaming || streamingText);
  const hasStreamingContent = Boolean(streamingText && streamingText.trim().length > 0);

  // Group events into message turns with their associated tool steps
  const turns = useMemo(() => groupEventsIntoTurns(visible), [visible]);

  // Track expanded state for each turn's steps
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());

  const toggleExpanded = (turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  };

  // Get running tool for streaming indicator
  const runningTool = getCurrentRunningTool(visible);

  return (
    <div className="event-list">
      {turns.length === 0 && !showStreaming ? (
        <div className="event-empty">Start a conversation</div>
      ) : (
        <>
          {turns.map((turn) => {
            const userText = getEventText(turn.userMessage);
            const userAttachments = getAttachments(turn.userMessage);
            const assistantText = turn.assistantMessage
              ? getEventText(turn.assistantMessage)
              : "";
            const hasSteps = turn.steps.length > 0;
            const hasAssistantContent = assistantText.trim().length > 0;
            const isExpanded = expandedTurns.has(turn.id);
            const hasRunningStep = turn.steps.some((s) => s.status === "running");

            return (
              <div key={turn.id} className="session-turn">
                {/* User message */}
                <div className="event-item user">
                  <div className="event-body">{userText}</div>
                  {userAttachments.length > 0 && (
                    <div className="event-attachments">
                      {userAttachments.map((attachment, index) => {
                        if (attachment.url) {
                          return (
                            <img
                              key={attachment.id ?? `${index}`}
                              src={attachment.url}
                              alt="Attachment"
                              className="event-attachment"
                              onClick={() => onOpenAttachment?.(attachment)}
                              role={onOpenAttachment ? "button" : undefined}
                              tabIndex={onOpenAttachment ? 0 : undefined}
                              onKeyDown={(eventKey) => {
                                if (
                                  onOpenAttachment &&
                                  (eventKey.key === "Enter" || eventKey.key === " ")
                                ) {
                                  onOpenAttachment(attachment);
                                }
                              }}
                            />
                          );
                        }
                        return (
                          <div
                            key={attachment.id ?? `${index}`}
                            className="event-attachment-fallback"
                          >
                            Attachment {index + 1}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Steps container (tool calls) */}
                {hasSteps && (
                  <div className="event-item assistant steps-wrapper">
                    <StepsContainer
                      steps={turn.steps}
                      expanded={isExpanded}
                      working={hasRunningStep}
                      onToggle={() => toggleExpanded(turn.id)}
                    />
                  </div>
                )}

                {/* Assistant message */}
                {hasAssistantContent && (
                  <div className="event-item assistant">
                    <Markdown
                      text={assistantText}
                      cacheKey={turn.assistantMessage?._id}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* Streaming indicator */}
          {showStreaming && (
            <div className="session-turn">
              <div className="event-item assistant streaming">
                <WorkingIndicator
                  isResponding={hasStreamingContent}
                  isReasoning={!hasStreamingContent}
                  toolName={runningTool}
                />
                {hasStreamingContent && streamingText && (
                  <Markdown text={streamingText} />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
