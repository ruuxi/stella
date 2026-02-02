import { useMemo } from "react";
import type { EventRecord, MessagePayload, Attachment } from "../hooks/use-conversation-events";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
  getRunningTasks,
} from "../hooks/use-conversation-events";
import { WorkingIndicator } from "../components/chat/WorkingIndicator";
import { Markdown } from "../components/chat/Markdown";
import { ReasoningSection } from "../components/chat/ReasoningSection";
import { TaskIndicator } from "../components/chat/TaskIndicator";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  reasoningText?: string;
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
  reasoningText,
  isStreaming,
  onOpenAttachment,
}: Props) => {
  const visible = maxItems ? events.slice(-maxItems) : events;
  const showStreaming = Boolean(isStreaming || streamingText);
  const hasStreamingContent = Boolean(streamingText && streamingText.trim().length > 0);
  const hasReasoningContent = Boolean(reasoningText && reasoningText.trim().length > 0);

  // Group events into message turns with their associated tool steps
  const turns = useMemo(() => groupEventsIntoTurns(visible), [visible]);

  // Get running tool for streaming indicator
  const runningTool = getCurrentRunningTool(visible);

  // Get running tasks for task indicator
  const runningTasks = useMemo(() => getRunningTasks(visible), [visible]);

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
            const hasAssistantContent = assistantText.trim().length > 0;

            const hasUserContent = userText.trim().length > 0 || userAttachments.length > 0;

            return (
              <div key={turn.id} className="session-turn">
                {/* User message (skip if empty, e.g., for standalone assistant messages) */}
                {hasUserContent && (
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
                {/* Show active tasks when agents are working */}
                {runningTasks.length > 0 && (
                  <TaskIndicator tasks={runningTasks} />
                )}
                {/* Show reasoning section when we have reasoning content */}
                {hasReasoningContent && (
                  <ReasoningSection
                    content={reasoningText!}
                    isStreaming={isStreaming && !hasStreamingContent}
                  />
                )}
                {/* Show working indicator when no content yet */}
                {!hasStreamingContent && !hasReasoningContent && runningTasks.length === 0 && (
                  <WorkingIndicator
                    isResponding={false}
                    isReasoning={true}
                    toolName={runningTool}
                  />
                )}
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
