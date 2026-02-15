import { memo } from "react";
import type { Attachment, ChannelEnvelope, TaskItem } from "../../hooks/use-conversation-events";
import { WorkingIndicator } from "../../components/chat/WorkingIndicator";
import { TaskIndicator } from "../../components/chat/TaskIndicator";
import { Markdown } from "../../components/chat/Markdown";
import { ReasoningSection } from "../../components/chat/ReasoningSection";
import type { EventRecord, MessagePayload } from "../../hooks/use-conversation-events";

export type TurnViewModel = {
  id: string;
  userText: string;
  userAttachments: Attachment[];
  userChannelEnvelope?: ChannelEnvelope;
  assistantText: string;
  assistantMessageId: string | null;
  assistantEmotesEnabled: boolean;
};

export type StreamingTurnProps = {
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  runningTasks: TaskItem[];
  runningTool?: string;
};

// eslint-disable-next-line react-refresh/only-export-components
export const getEventText = (event: EventRecord): string => {
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as MessagePayload;
    return payload.text ?? payload.content ?? payload.message ?? "";
  }
  return "";
};

// eslint-disable-next-line react-refresh/only-export-components
export const getAttachments = (event: EventRecord): Attachment[] => {
  const fromPayload =
    event.payload && typeof event.payload === "object"
      ? ((event.payload as MessagePayload).attachments ?? [])
      : [];
  const fromEnvelope = event.channelEnvelope?.attachments ?? [];
  if (fromEnvelope.length === 0) {
    return fromPayload;
  }

  const deduped = new Map<string, Attachment>();
  for (const attachment of [...fromPayload, ...fromEnvelope]) {
    const key = [
      attachment.id ?? "",
      attachment.url ?? "",
      attachment.name ?? "",
      attachment.mimeType ?? "",
      attachment.kind ?? "",
    ].join("|");
    if (!deduped.has(key)) {
      deduped.set(key, attachment);
    }
  }
  return Array.from(deduped.values());
};

// eslint-disable-next-line react-refresh/only-export-components
export const getChannelEnvelope = (event: EventRecord): ChannelEnvelope | undefined => {
  if (!event.channelEnvelope || typeof event.channelEnvelope !== "object") {
    return undefined;
  }
  return event.channelEnvelope;
};

const getAttachmentLabel = (attachment: Attachment, index: number) => {
  if (attachment.name) return attachment.name;
  if (attachment.kind) {
    const normalized = attachment.kind.replace(/[_-]+/g, " ").trim();
    if (normalized.length > 0) {
      return normalized[0].toUpperCase() + normalized.slice(1);
    }
  }
  if (attachment.mimeType) return attachment.mimeType;
  return `Attachment ${index + 1}`;
};

const formatChannelKind = (kind: ChannelEnvelope["kind"]) => {
  if (kind === "message") return "message";
  if (kind === "reaction") return "reaction";
  if (kind === "edit") return "edited";
  if (kind === "delete") return "deleted";
  return "system";
};

const formatProvider = (provider: string) =>
  provider
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");

const summarizeReactions = (envelope: ChannelEnvelope): string | null => {
  const reactions = envelope.reactions ?? [];
  if (reactions.length === 0) return null;
  const labels = reactions.slice(0, 3).map((reaction) => {
    const prefix = reaction.action === "remove" ? "-" : "+";
    return `${prefix}${reaction.emoji}`;
  });
  const suffix = reactions.length > 3 ? ` +${reactions.length - 3}` : "";
  return `Reactions ${labels.join(" ")}${suffix}`;
};

// eslint-disable-next-line react-refresh/only-export-components
export function attachmentsEqual(a: Attachment[], b: Attachment[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];

    if ((av.id ?? null) !== (bv.id ?? null)) return false;
    if ((av.url ?? null) !== (bv.url ?? null)) return false;
    if ((av.mimeType ?? null) !== (bv.mimeType ?? null)) return false;
    if ((av.name ?? null) !== (bv.name ?? null)) return false;
  }

  return true;
}

/** Memoized turn renderer to prevent unnecessary re-renders */
export const TurnItem = memo(function TurnItem({
  turn,
  onOpenAttachment,
  streaming,
}: {
  turn: TurnViewModel;
  onOpenAttachment?: (attachment: Attachment) => void;
  streaming?: StreamingTurnProps;
}) {
  const userText = turn.userText;
  const userAttachments = turn.userAttachments;
  const userChannelEnvelope = turn.userChannelEnvelope;
  const assistantText = turn.assistantText;
  const hasAssistantContent = assistantText.trim().length > 0;
  const hasUserContent =
    userText.trim().length > 0 || userAttachments.length > 0;
  const hasChannelMeta = Boolean(userChannelEnvelope?.provider);
  const reactionSummary = userChannelEnvelope
    ? summarizeReactions(userChannelEnvelope)
    : null;

  const hasStreamingContent = Boolean(streaming?.streamingText?.trim().length);
  const hasReasoningContent = Boolean(streaming?.reasoningText?.trim().length);
  const shouldShowStreamingAssistant = Boolean(
    !hasAssistantContent &&
      Boolean(streaming) &&
      (hasStreamingContent ||
        hasReasoningContent ||
        (streaming?.runningTasks.length ?? 0) > 0 ||
        streaming?.isStreaming),
  );

  const shouldShowAssistantArea =
    hasAssistantContent || shouldShowStreamingAssistant;
  const assistantDisplayText = hasAssistantContent
    ? assistantText
    : (streaming?.streamingText ?? "");
  const assistantEnableEmotes = hasAssistantContent
    ? turn.assistantEmotesEnabled
    : shouldShowStreamingAssistant;
  const assistantCacheKey = `assistant-${turn.id}`;

  return (
    <div className="session-turn">
      {/* User message (skip if empty, e.g., for standalone assistant messages) */}
      {hasUserContent && (
        <div className="event-item user">
          {(() => {
            const windowMatch = userText.match(
              /^<active-window[^>]*>(.+?)<\/active-window>\s*/,
            );
            const windowContext = windowMatch ? windowMatch[1] : null;
            const displayText = windowMatch
              ? userText.slice(windowMatch[0].length)
              : userText;
            return (
              <>
                {windowContext && (
                  <span className="event-window-badge">{windowContext}</span>
                )}
                {hasChannelMeta && userChannelEnvelope && (
                  <div className="event-channel-meta">
                    <span className="event-channel-badge provider">
                      {formatProvider(userChannelEnvelope.provider)}
                    </span>
                    {userChannelEnvelope.kind !== "message" && (
                      <span className="event-channel-badge kind">
                        {formatChannelKind(userChannelEnvelope.kind)}
                      </span>
                    )}
                    {reactionSummary && (
                      <span className="event-channel-badge reaction">
                        {reactionSummary}
                      </span>
                    )}
                  </div>
                )}
                {displayText.trim() && (
                  <div className="event-body">{displayText}</div>
                )}
              </>
            );
          })()}
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
                    {getAttachmentLabel(attachment, index)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Assistant / Streaming assistant (keep mounted to avoid flicker on completion) */}
      {shouldShowAssistantArea && (
        <div
          className={`event-item assistant${shouldShowStreamingAssistant ? " streaming" : ""}`}
        >
          {shouldShowStreamingAssistant && streaming && (
            <>
              {streaming.runningTasks.length > 0 && (
                <TaskIndicator tasks={streaming.runningTasks} />
              )}
              {hasReasoningContent && streaming.reasoningText && (
                <ReasoningSection
                  content={streaming.reasoningText}
                  isStreaming={Boolean(
                    streaming.isStreaming && !hasStreamingContent,
                  )}
                />
              )}
              {!hasStreamingContent &&
                !hasReasoningContent &&
                streaming.runningTasks.length === 0 && (
                  <WorkingIndicator
                    isReasoning={true}
                    toolName={streaming.runningTool}
                  />
                )}
            </>
          )}

          {assistantDisplayText.trim().length > 0 && (
            <Markdown
              text={assistantDisplayText}
              cacheKey={assistantCacheKey}
              isAnimating={
                shouldShowStreamingAssistant && streaming?.isStreaming
              }
              enableEmotes={assistantEnableEmotes}
            />
          )}
        </div>
      )}
    </div>
  );
});

/** Streaming indicator component */
export const StreamingIndicator = memo(function StreamingIndicator({
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  runningTasks,
  runningTool,
}: {
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  runningTasks: TaskItem[];
  runningTool?: string;
}) {
  const hasStreamingContent = Boolean(
    streamingText && streamingText.trim().length > 0,
  );
  const hasReasoningContent = Boolean(
    reasoningText && reasoningText.trim().length > 0,
  );

  return (
    <div className="session-turn">
      <div className="event-item assistant streaming">
        {runningTasks.length > 0 && (
          <TaskIndicator tasks={runningTasks} />
        )}
        {hasReasoningContent && (
          <ReasoningSection
            content={reasoningText!}
            isStreaming={isStreaming && !hasStreamingContent}
          />
        )}
        {!hasStreamingContent &&
          !hasReasoningContent &&
          runningTasks.length === 0 && (
            <WorkingIndicator
              isReasoning={true}
              toolName={runningTool}
            />
          )}
        {hasStreamingContent && streamingText && (
          <Markdown
            text={streamingText}
            cacheKey={
              pendingUserMessageId
                ? `streaming-${pendingUserMessageId}`
                : undefined
            }
            isAnimating={isStreaming}
            enableEmotes={true}
          />
        )}
      </div>
    </div>
  );
});
