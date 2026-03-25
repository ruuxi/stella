import { memo } from "react";
import type { Attachment, ChannelEnvelope, TaskItem } from "@/app/chat/lib/event-transforms";
import { WorkingIndicator } from "@/app/chat/WorkingIndicator";
import { TaskIndicator } from "@/app/chat/TaskIndicator";
import { Markdown } from "@/app/chat/Markdown";
import { ReasoningSection } from "@/app/chat/ReasoningSection";
import { SelfModUndoButton } from "@/app/chat/SelfModUndoButton";
import { GrowIn } from "@/app/chat/GrowIn";
import type { SelfModApplied } from "@/app/chat/SelfModUndoButton";
import {
  getEventText,
  type EventRecord,
  type MessagePayload,
} from "@/app/chat/lib/event-transforms";
import { sanitizeAttachmentImageUrl } from "@/shared/lib/url-safety";

export type TurnViewModel = {
  id: string;
  userText: string;
  userAttachments: Attachment[];
  userChannelEnvelope?: ChannelEnvelope;
  assistantText: string;
  assistantMessageId: string | null;
  assistantEmotesEnabled: boolean;
  webSearchBadgeHtml?: string;
  selfModApplied?: SelfModApplied;
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
export const getAttachments = (event: EventRecord): Attachment[] => {
  const fromPayload = (event.payload as MessagePayload | undefined)?.attachments ?? [];
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
export const getChannelEnvelope = (event: EventRecord): ChannelEnvelope | undefined =>
  event.channelEnvelope;

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

const LEADING_TIME_TAG_RE =
  /^\[(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)(?:,\s+[A-Za-z]{3}\s+\d{1,2})?\]\s*/i;
const TRAILING_TIME_TAG_RE =
  /\s*\n\n\[(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)(?:,\s+[A-Za-z]{3}\s+\d{1,2})?\]$/i;

const isChannelMessageEvent = (event: EventRecord): boolean => {
  if (event.channelEnvelope && typeof event.channelEnvelope === "object") {
    return true;
  }
  if (!event.payload || typeof event.payload !== "object") {
    return false;
  }
  const source = (event.payload as MessagePayload).source;
  return typeof source === "string" && source.trim().toLowerCase().startsWith("channel:");
};

// eslint-disable-next-line react-refresh/only-export-components
export const getDisplayMessageText = (event: EventRecord): string => {
  const text = getEventText(event).replace(TRAILING_TIME_TAG_RE, "");
  if (!isChannelMessageEvent(event)) {
    return text;
  }
  return text.replace(LEADING_TIME_TAG_RE, "");
};

// eslint-disable-next-line react-refresh/only-export-components
export const getDisplayUserText = getDisplayMessageText;

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

const renderWebSearchBadge = (_html: string) => (
  <div className="event-search-badge">
    <span className="event-search-badge-label">Search briefing</span>
  </div>
);

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

const reactionsEqual = (
  a: ChannelEnvelope["reactions"] | undefined,
  b: ChannelEnvelope["reactions"] | undefined,
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let i = 0; i < left.length; i += 1) {
    const av = left[i];
    const bv = right[i];
    if (!av || !bv) return false;
    if (av.emoji !== bv.emoji) return false;
    if (av.action !== bv.action) return false;
    if ((av.targetMessageId ?? null) !== (bv.targetMessageId ?? null)) return false;
  }

  return true;
};

const channelEnvelopeEqual = (
  a: ChannelEnvelope | undefined,
  b: ChannelEnvelope | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;

  return (
    a.provider === b.provider &&
    a.kind === b.kind &&
    reactionsEqual(a.reactions, b.reactions)
  );
};

const selfModAppliedEqual = (
  a: SelfModApplied | undefined,
  b: SelfModApplied | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.featureId !== b.featureId || a.batchIndex !== b.batchIndex) {
    return false;
  }
  if (a.files.length !== b.files.length) {
    return false;
  }
  for (let i = 0; i < a.files.length; i += 1) {
    if (a.files[i] !== b.files[i]) {
      return false;
    }
  }
  return true;
};

const taskItemEqual = (a: TaskItem, b: TaskItem): boolean => (
  a.id === b.id &&
  a.description === b.description &&
  a.agentType === b.agentType &&
  a.status === b.status &&
  (a.parentTaskId ?? null) === (b.parentTaskId ?? null) &&
  (a.statusText ?? null) === (b.statusText ?? null)
);

const runningTasksEqual = (a: TaskItem[], b: TaskItem[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!taskItemEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
};

const streamingPropsEqual = (
  a: StreamingTurnProps | undefined,
  b: StreamingTurnProps | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;

  return (
    a.streamingText === b.streamingText &&
    a.reasoningText === b.reasoningText &&
    Boolean(a.isStreaming) === Boolean(b.isStreaming) &&
    (a.pendingUserMessageId ?? null) === (b.pendingUserMessageId ?? null) &&
    (a.runningTool ?? null) === (b.runningTool ?? null) &&
    runningTasksEqual(a.runningTasks, b.runningTasks)
  );
};

const turnViewModelEqual = (a: TurnViewModel, b: TurnViewModel): boolean => (
  a.id === b.id &&
  a.userText === b.userText &&
  attachmentsEqual(a.userAttachments, b.userAttachments) &&
  channelEnvelopeEqual(a.userChannelEnvelope, b.userChannelEnvelope) &&
  a.assistantText === b.assistantText &&
  a.assistantMessageId === b.assistantMessageId &&
  a.assistantEmotesEnabled === b.assistantEmotesEnabled &&
  (a.webSearchBadgeHtml ?? null) === (b.webSearchBadgeHtml ?? null) &&
  selfModAppliedEqual(a.selfModApplied, b.selfModApplied)
);

const areTurnItemPropsEqual = (
  prev: {
    turn: TurnViewModel;
    onOpenAttachment?: (attachment: Attachment) => void;
    streaming?: StreamingTurnProps;
  },
  next: {
    turn: TurnViewModel;
    onOpenAttachment?: (attachment: Attachment) => void;
    streaming?: StreamingTurnProps;
  },
): boolean => (
  prev.onOpenAttachment === next.onOpenAttachment &&
  turnViewModelEqual(prev.turn, next.turn) &&
  streamingPropsEqual(prev.streaming, next.streaming)
);

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
  const webSearchBadgeHtml = turn.webSearchBadgeHtml?.trim() ?? "";
  const hasAssistantContent = assistantText.trim().length > 0;
  const hasWebSearchBadge = webSearchBadgeHtml.length > 0;
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
    hasAssistantContent ||
    hasWebSearchBadge ||
    (shouldShowStreamingAssistant && (hasStreamingContent || hasReasoningContent));
  const assistantDisplayText = hasAssistantContent
    ? assistantText
    : (streaming?.streamingText ?? "");
  const assistantEnableEmotes = hasAssistantContent
    ? turn.assistantEmotesEnabled
    : shouldShowStreamingAssistant;
  const assistantCacheKey = `assistant-${turn.id}`;

  return (
    <div className="session-turn" data-turn-id={turn.id}>
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
                {hasChannelMeta && (
                  <div className="event-channel-meta">
                    {userChannelEnvelope?.provider && (
                      <span className="event-channel-badge provider">
                        {formatProvider(userChannelEnvelope.provider)}
                      </span>
                    )}
                    {userChannelEnvelope && userChannelEnvelope.kind !== "message" && (
                      <span className="event-channel-badge kind">
                        {formatChannelKind(userChannelEnvelope.kind)}
                      </span>
                    )}
                    {userChannelEnvelope && reactionSummary && (
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
                const safeUrl = sanitizeAttachmentImageUrl(attachment.url);
                if (safeUrl) {
                  return (
                    <img
                      key={attachment.id ?? `${index}`}
                      src={safeUrl}
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

      {/* Consolidated activity indicator — tasks + thinking in one element */}
      {shouldShowStreamingAssistant && streaming &&
        !hasStreamingContent && !hasReasoningContent && (
        <GrowIn
          animate={true}
          show={!hasAssistantContent}
        >
          {streaming.runningTasks.length > 0 ? (
            <TaskIndicator tasks={streaming.runningTasks} />
          ) : (
            <WorkingIndicator
              isReasoning={true}
              toolName={streaming.runningTool}
            />
          )}
        </GrowIn>
      )}

      {/* Assistant / Streaming assistant */}
      {shouldShowAssistantArea && (
        <div
          className={`event-item assistant${shouldShowStreamingAssistant ? " streaming" : ""}`}
        >
          {shouldShowStreamingAssistant && streaming && (
            <>
              {hasReasoningContent && streaming.reasoningText && (
                <ReasoningSection
                  content={streaming.reasoningText}
                  isStreaming={Boolean(
                    streaming.isStreaming && !hasStreamingContent,
                  )}
                />
              )}
            </>
          )}

          {hasWebSearchBadge && renderWebSearchBadge(webSearchBadgeHtml)}

          {assistantDisplayText.trim().length > 0 && (
            <GrowIn animate={shouldShowStreamingAssistant && Boolean(streaming?.isStreaming)}>
              <div className={shouldShowStreamingAssistant && streaming?.isStreaming ? "text-reveal" : undefined}>
                <Markdown
                  text={assistantDisplayText}
                  cacheKey={assistantCacheKey}
                  isAnimating={
                    shouldShowStreamingAssistant && streaming?.isStreaming
                  }
                  enableEmotes={assistantEnableEmotes}
                />
              </div>
            </GrowIn>
          )}

          {turn.selfModApplied && !shouldShowStreamingAssistant && (
            <SelfModUndoButton selfModApplied={turn.selfModApplied} />
          )}
        </div>
      )}
    </div>
  );
}, areTurnItemPropsEqual);

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

  const hasContent = hasStreamingContent || hasReasoningContent;

  return (
    <div className="session-turn">
      {/* Consolidated activity indicator */}
      {!hasContent && (
        <GrowIn animate={true} show={true}>
          {runningTasks.length > 0 ? (
            <TaskIndicator tasks={runningTasks} />
          ) : (
            <WorkingIndicator
              isReasoning={true}
              toolName={runningTool}
            />
          )}
        </GrowIn>
      )}

      {hasContent && (
        <div className="event-item assistant streaming">
          {hasReasoningContent && (
            <ReasoningSection
              content={reasoningText!}
              isStreaming={isStreaming && !hasStreamingContent}
            />
          )}
          {hasStreamingContent && streamingText && (
            <GrowIn animate={Boolean(isStreaming)}>
              <div className={isStreaming ? "text-reveal" : undefined}>
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
              </div>
            </GrowIn>
          )}
        </div>
      )}
    </div>
  );
});
