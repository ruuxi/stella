import { memo, useRef, useState, useEffect } from "react";
import type { Attachment, ChannelEnvelope } from "@/app/chat/lib/event-transforms";
import { Markdown } from "@/app/chat/Markdown";
import { EndResourceCard } from "@/app/chat/EndResourceCard";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { ReasoningSection } from "@/app/chat/ReasoningSection";
import { SelfModUndoButton } from "@/app/chat/SelfModUndoButton";
import type { SelfModApplied } from "@/app/chat/SelfModUndoButton";
import {
  getEventText,
  type EventRecord,
  type MessagePayload,
} from "@/app/chat/lib/event-transforms";
import type { OfficePreviewRef } from "@/shared/contracts/office-preview";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { sanitizeAttachmentImageUrl } from "@/shared/lib/url-safety";
import { GrowIn } from "@/app/chat/GrowIn";
import {
  AskQuestionBubble,
  type AskQuestionState,
} from "@/app/chat/AskQuestionBubble";
import { UserMessageBody } from "@/app/chat/UserMessageBody";

export type TurnViewModel = {
  id: string;
  userText: string;
  userWindowLabel?: string;
  userWindowPreviewImageUrl?: string;
  userAttachments: Attachment[];
  userChannelEnvelope?: ChannelEnvelope;
  assistantText: string;
  assistantMessageId: string | null;
  assistantEmotesEnabled: boolean;
  webSearchBadgeHtml?: string;
  officePreviewRef?: OfficePreviewRef;
  /**
   * Primary artifact this turn produced (or read), if any. When set the
   * UI renders an "end-resource" pill below the assistant content; click
   * opens the matching Display sidebar tab. Mirrors Codex's per-turn
   * artifact card.
   */
  resourcePayload?: DisplayPayload;
  selfModApplied?: SelfModApplied;
  askQuestion?: AskQuestionState;
};

export type StreamingTurnProps = {
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
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

import {
  LEADING_TIME_TAG_RE,
  TRAILING_TIME_TAG_RE,
} from "@/shared/lib/message-timestamp";

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
export const getDisplayUserText = (event: EventRecord): string => {
  const text = getEventText(event).replace(TRAILING_TIME_TAG_RE, "");
  if (!isChannelMessageEvent(event)) {
    return text;
  }
  return text.replace(LEADING_TIME_TAG_RE, "");
};

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
    (a.pendingUserMessageId ?? null) === (b.pendingUserMessageId ?? null)
  );
};

const askQuestionPayloadEqual = (
  a: AskQuestionState | undefined,
  b: AskQuestionState | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (Boolean(a.submitted) !== Boolean(b.submitted)) return false;
  if (a.questions.length !== b.questions.length) return false;
  for (let i = 0; i < a.questions.length; i += 1) {
    const left = a.questions[i];
    const right = b.questions[i];
    if (left.question !== right.question) return false;
    if (Boolean(left.allowOther) !== Boolean(right.allowOther)) return false;
    if (left.options.length !== right.options.length) return false;
    for (let j = 0; j < left.options.length; j += 1) {
      if (left.options[j].label !== right.options[j].label) return false;
    }
    const leftSelection = a.selections?.[i];
    const rightSelection = b.selections?.[i];
    if (leftSelection?.kind !== rightSelection?.kind) return false;
    if (
      leftSelection?.kind === "option" &&
      rightSelection?.kind === "option" &&
      leftSelection.key !== rightSelection.key
    ) {
      return false;
    }
    if (
      leftSelection?.kind === "other" &&
      rightSelection?.kind === "other" &&
      leftSelection.text !== rightSelection.text
    ) {
      return false;
    }
  }
  return true;
};

const resourcePayloadEqual = (
  a: DisplayPayload | undefined,
  b: DisplayPayload | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "html":
      return a.html === (b as { html: string }).html;
    case "office":
      return (
        a.previewRef.sourcePath ===
        (b as { previewRef: OfficePreviewRef }).previewRef.sourcePath
      );
    case "pdf":
      return a.filePath === (b as { filePath: string }).filePath;
    case "media": {
      const bb = b as Extract<DisplayPayload, { kind: "media" }>;
      if (a.asset.kind !== bb.asset.kind) return false;
      if (a.asset.kind === "image" && bb.asset.kind === "image") {
        return a.asset.filePaths.join("|") === bb.asset.filePaths.join("|");
      }
      if (
        (a.asset.kind === "video" || a.asset.kind === "audio")
        && (bb.asset.kind === "video" || bb.asset.kind === "audio")
      ) {
        return a.asset.filePath === bb.asset.filePath;
      }
      return JSON.stringify(a.asset) === JSON.stringify(bb.asset);
    }
  }
};

const turnViewModelEqual = (a: TurnViewModel, b: TurnViewModel): boolean => (
  a.id === b.id &&
  a.userText === b.userText &&
  (a.userWindowLabel ?? null) === (b.userWindowLabel ?? null) &&
  (a.userWindowPreviewImageUrl ?? null) === (b.userWindowPreviewImageUrl ?? null) &&
  attachmentsEqual(a.userAttachments, b.userAttachments) &&
  channelEnvelopeEqual(a.userChannelEnvelope, b.userChannelEnvelope) &&
  a.assistantText === b.assistantText &&
  a.assistantMessageId === b.assistantMessageId &&
  a.assistantEmotesEnabled === b.assistantEmotesEnabled &&
  (a.webSearchBadgeHtml ?? null) === (b.webSearchBadgeHtml ?? null) &&
  (a.officePreviewRef?.sessionId ?? null) ===
    (b.officePreviewRef?.sessionId ?? null) &&
  resourcePayloadEqual(a.resourcePayload, b.resourcePayload) &&
  askQuestionPayloadEqual(a.askQuestion, b.askQuestion) &&
  selfModAppliedEqual(a.selfModApplied, b.selfModApplied)
);

const areTurnItemPropsEqual = (
  prev: {
    turn: TurnViewModel;
    isLastTurn?: boolean;
    onOpenAttachment?: (attachment: Attachment) => void;
    streaming?: StreamingTurnProps;
    taskReasoningText?: string;
    taskReasoningDescription?: string;
  },
  next: {
    turn: TurnViewModel;
    isLastTurn?: boolean;
    onOpenAttachment?: (attachment: Attachment) => void;
    streaming?: StreamingTurnProps;
    taskReasoningText?: string;
    taskReasoningDescription?: string;
  },
): boolean => (
  prev.onOpenAttachment === next.onOpenAttachment &&
  prev.isLastTurn === next.isLastTurn &&
  (prev.taskReasoningText ?? "") === (next.taskReasoningText ?? "") &&
  (prev.taskReasoningDescription ?? "") === (next.taskReasoningDescription ?? "") &&
  turnViewModelEqual(prev.turn, next.turn) &&
  streamingPropsEqual(prev.streaming, next.streaming)
);

/** Memoized turn renderer to prevent unnecessary re-renders */
export const TurnItem = memo(function TurnItem({
  turn,
  isLastTurn = false,
  onOpenAttachment,
  streaming,
  taskReasoningText,
  taskReasoningDescription,
}: {
  turn: TurnViewModel;
  /** Latest turn in the thread: keeps expanded reply region after streaming ends. */
  isLastTurn?: boolean;
  onOpenAttachment?: (attachment: Attachment) => void;
  streaming?: StreamingTurnProps;
  taskReasoningText?: string;
  taskReasoningDescription?: string;
}) {
  const userText = turn.userText;
  const userWindowLabel = turn.userWindowLabel;
  const userWindowPreviewImageUrl = sanitizeAttachmentImageUrl(
    turn.userWindowPreviewImageUrl,
  );
  const userAttachments = turn.userAttachments;
  const userChannelEnvelope = turn.userChannelEnvelope;
  const assistantText = turn.assistantText;
  const webSearchBadgeHtml = turn.webSearchBadgeHtml?.trim() ?? "";
  const officePreviewRef = turn.officePreviewRef;
  const hasAssistantContent = assistantText.trim().length > 0;
  const hasWebSearchBadge = webSearchBadgeHtml.length > 0;
  const hasOfficePreview = Boolean(officePreviewRef);
  const hasUserContent =
    userText.trim().length > 0 || userAttachments.length > 0 || Boolean(userWindowLabel);
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
        streaming?.isStreaming),
  );

  const shouldShowAssistantArea =
    hasAssistantContent ||
    hasWebSearchBadge ||
    hasOfficePreview ||
    shouldShowStreamingAssistant;
  const trimmedTaskReasoningText = taskReasoningText?.trim() ?? "";
  const hasTaskReasoning = trimmedTaskReasoningText.length > 0;

  const MIN_DISPLAY_HOLD_MS = 3000;
  const shownSinceRef = useRef<number>(0);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(
    turn.assistantMessageId,
  );
  const hadPreviousMessageRef = useRef(false);

  const currentAssistantMessageId = turn.assistantMessageId;

  useEffect(() => {
    if (!currentAssistantMessageId) return;

    if (visibleMessageId === null) {
      shownSinceRef.current = Date.now();
      setVisibleMessageId(currentAssistantMessageId);
      return;
    }

    if (currentAssistantMessageId === visibleMessageId) return;

    hadPreviousMessageRef.current = true;
    const elapsed = Date.now() - shownSinceRef.current;
    const holdRemaining = Math.max(0, MIN_DISPLAY_HOLD_MS - elapsed);

    const commit = () => {
      shownSinceRef.current = Date.now();
      setVisibleMessageId(currentAssistantMessageId);
    };

    if (holdRemaining <= 0) {
      commit();
      return;
    }

    const timer = window.setTimeout(commit, holdRemaining);
    return () => window.clearTimeout(timer);
  }, [currentAssistantMessageId, visibleMessageId]);

  const animateReplacement = hadPreviousMessageRef.current;

  const assistantDisplayText = hasAssistantContent
    ? assistantText
    : (streaming?.streamingText ?? "");
  const assistantEnableEmotes = hasAssistantContent
    ? turn.assistantEmotesEnabled
    : shouldShowStreamingAssistant;
  const assistantCacheKey = `assistant-${turn.id}`;

  const hasEverHadContent = useRef(hasAssistantContent);
  if (hasAssistantContent) hasEverHadContent.current = true;

  const showEntrance = !hasEverHadContent.current;

  return (
    <div
      className={`session-turn${showEntrance ? " fade-up-turn" : ""}${isLastTurn ? " session-turn--last-turn" : ""}`}
      data-turn-id={turn.id}
    >
      {/* User message (skip if empty, e.g., for standalone assistant messages) */}
      {hasUserContent && (
        <div className="event-item user">
          <>
            {userWindowLabel && (
              <span className="event-window-badge-hovercard">
                <span
                  className="event-window-badge"
                  tabIndex={userWindowPreviewImageUrl ? 0 : undefined}
                >
                  {userWindowLabel}
                </span>
                {userWindowPreviewImageUrl && (
                  <div className="event-window-preview" role="tooltip">
                    <img
                      src={userWindowPreviewImageUrl}
                      alt="Window content preview"
                      className="event-window-preview-img"
                    />
                  </div>
                )}
              </span>
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
            {userText.trim() && <UserMessageBody text={userText} />}
          </>
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

      {/* Assistant / Streaming assistant */}
      {shouldShowAssistantArea && (
        <GrowIn
          key={animateReplacement ? `replace-${visibleMessageId}` : turn.id}
          animate={animateReplacement || showEntrance}
          duration={animateReplacement ? 400 : 500}
        >
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
              <Markdown
                text={assistantDisplayText}
                cacheKey={assistantCacheKey}
                isAnimating={
                  shouldShowStreamingAssistant && streaming?.isStreaming
                }
                enableEmotes={assistantEnableEmotes}
              />
            )}

            {officePreviewRef && <OfficePreviewCard previewRef={officePreviewRef} />}

            {turn.resourcePayload && !shouldShowStreamingAssistant && (
              <EndResourceCard payload={turn.resourcePayload} />
            )}

            {turn.selfModApplied && !shouldShowStreamingAssistant && (
              <SelfModUndoButton selfModApplied={turn.selfModApplied} />
            )}
          </div>
        </GrowIn>
      )}

      {turn.askQuestion && <AskQuestionBubble payload={turn.askQuestion} />}

      {hasTaskReasoning && (
        <div className="subagent-reasoning-attach">
          <ReasoningSection
            className="reasoning-section--subagent"
            content={trimmedTaskReasoningText}
            headingLabel={taskReasoningDescription}
            isStreaming
          />
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
}: {
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
}) {
  const hasStreamingContent = Boolean(
    streamingText && streamingText.trim().length > 0,
  );
  const hasReasoningContent = Boolean(
    reasoningText && reasoningText.trim().length > 0,
  );

  const hasContent = hasStreamingContent || hasReasoningContent;

  if (!hasContent) {
    return null;
  }

  return (
    <div className="session-turn session-turn--last-turn">
      <div className="event-item assistant streaming">
        {hasReasoningContent && (
          <ReasoningSection
            content={reasoningText!}
            isStreaming={isStreaming && !hasStreamingContent}
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
