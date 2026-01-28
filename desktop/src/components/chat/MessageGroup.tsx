import React from "react";
import type { EventRecord, MessagePayload, Attachment } from "../../hooks/use-conversation-events";
import type { StepItem } from "../steps-container";
import { StepsContainer } from "../steps-container";
import { WorkingIndicator } from "./WorkingIndicator";
import { Markdown } from "./Markdown";

type MessageGroupProps = {
  userMessage: EventRecord;
  assistantMessage?: EventRecord;
  steps: StepItem[];
  isStreaming?: boolean;
  streamingText?: string;
  currentToolName?: string;
  onOpenAttachment?: (attachment: Attachment) => void;
};

const getMessageText = (event: EventRecord): string => {
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as MessagePayload;
    // Check common content field names
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

export function MessageGroup({
  userMessage,
  assistantMessage,
  steps,
  isStreaming,
  streamingText,
  currentToolName,
  onOpenAttachment,
}: MessageGroupProps) {
  const userText = getMessageText(userMessage);
  const userAttachments = getAttachments(userMessage);
  const assistantText = assistantMessage ? getMessageText(assistantMessage) : "";
  const hasStreamingContent = Boolean(streamingText && streamingText.trim().length > 0);

  // Show steps container if there are steps or if we're streaming with tool activity
  const showSteps = steps.length > 0 || (isStreaming && currentToolName);

  // Determine if we're still waiting for assistant response
  const showWorkingIndicator = isStreaming && !assistantMessage;

  // Get the running steps count
  const runningStepsCount = steps.filter((s) => s.status === "running").length;
  const isWorking = isStreaming || runningStepsCount > 0;

  // Expanded state for steps container
  const [stepsExpanded, setStepsExpanded] = React.useState(false);

  return (
    <div className="message-group">
      {/* User message */}
      <div className="session-turn">
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
                      onKeyDown={(e) => {
                        if (onOpenAttachment && (e.key === "Enter" || e.key === " ")) {
                          onOpenAttachment(attachment);
                        }
                      }}
                    />
                  );
                }
                return (
                  <div key={attachment.id ?? `${index}`} className="event-attachment-fallback">
                    Attachment {index + 1}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Steps container - shows tool calls */}
      {showSteps && (
        <div className="session-turn">
          <div className="event-item assistant steps">
            <StepsContainer
              steps={steps}
              expanded={stepsExpanded}
              working={isWorking}
              onToggle={() => setStepsExpanded(!stepsExpanded)}
            />
          </div>
        </div>
      )}

      {/* Working indicator - shows while streaming without content yet */}
      {showWorkingIndicator && (
        <div className="session-turn">
          <div className="event-item assistant streaming">
            <WorkingIndicator
              isResponding={hasStreamingContent}
              isReasoning={!hasStreamingContent}
              toolName={currentToolName}
            />
            {hasStreamingContent && streamingText && <Markdown text={streamingText} />}
          </div>
        </div>
      )}

      {/* Assistant message - shows completed response */}
      {assistantMessage && !isStreaming && (
        <div className="session-turn">
          <div className="event-item assistant">
            <Markdown text={assistantText} cacheKey={assistantMessage._id} />
          </div>
        </div>
      )}
    </div>
  );
}
