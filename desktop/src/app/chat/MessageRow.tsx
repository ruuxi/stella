/**
 * Linear chat row components.
 *
 * Each persisted message renders as a single row in chronological order,
 * with no per-turn user/assistant grouping. Tool-derived artifacts
 * (web-search badge, office preview, end-resource pill, self-mod undo,
 * ask-question bubble) attach to the assistant row that immediately
 * followed the producing tool events.
 *
 * Streaming is NOT a separate row: while a turn is in flight,
 * `useEventRows` synthesizes (or augments) a single assistant row keyed
 * by the user message id being responded to, then overlays the streaming
 * buffer onto its `text` and flips `isAnimating`. When the persisted
 * `assistant_message` lands, the same row keeps its identity (same React
 * key, same Markdown `cacheKey`) and just swaps its data source — no
 * unmount, no Streamdown re-parse, no flash.
 *
 * Reasoning text is intentionally NOT rendered anywhere in this surface
 * (the underlying data still flows through state for model history).
 */
import { memo, type ReactNode } from "react";
import type {
  Attachment,
  ChannelEnvelope,
} from "@/app/chat/lib/event-transforms";
import { Markdown } from "@/app/chat/Markdown";
import { EndResourceCard } from "@/app/chat/EndResourceCard";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { SelfModUndoButton } from "@/app/chat/SelfModUndoButton";
import type { SelfModApplied } from "@/app/chat/SelfModUndoButton";
import type { OfficePreviewRef } from "@/shared/contracts/office-preview";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { sanitizeAttachmentImageUrl } from "@/shared/lib/url-safety";
import {
  AskQuestionBubble,
  type AskQuestionState,
} from "@/app/chat/AskQuestionBubble";
import { UserMessageBody } from "@/app/chat/UserMessageBody";
import type { AgentResponseTarget } from "@/app/chat/streaming/streaming-types";
import { eventRowEqual } from "@/app/chat/lib/row-equality";

export type UserRowViewModel = {
  kind: "user";
  id: string;
  text: string;
  /** True only for the freshly-sent user bubble — drives the entry animation. */
  justSent?: boolean;
  windowLabel?: string;
  windowPreviewImageUrl?: string;
  attachments: Attachment[];
  channelEnvelope?: ChannelEnvelope;
};

export type AssistantRowViewModel = {
  kind: "assistant";
  /**
   * React key for this row. Stable across the streaming → persisted
   * transition: a row that responds to user message `U` keeps the same
   * `id` whether it's a placeholder fed by the streaming buffer, or the
   * persisted `assistant_message` that eventually replaces it.
   */
  id: string;
  text: string;
  /**
   * Stable Streamdown cache key. Same value across the streaming → persisted
   * swap so the markdown parse cache is reused.
   */
  cacheKey: string;
  /** True while the runtime is still streaming text into this row. */
  isAnimating?: boolean;
  emotesEnabled: boolean;
  responseTarget?: AgentResponseTarget;
  webSearchBadgeHtml?: string;
  officePreviewRef?: OfficePreviewRef;
  resourcePayload?: DisplayPayload;
  selfModApplied?: SelfModApplied;
  askQuestion?: AskQuestionState;
  /**
   * Optional renderer for surface-specific row attachments (e.g. the Store
   * thread's draft confirmation card). Mounted after the markdown body and
   * before askQuestion.
   *
   * Identity-stable per `customSlotKey` — the row equality comparator only
   * checks `customSlotKey` so re-rendering ancestors don't blow away the
   * memoized row when the renderer closure identity churns.
   */
  customSlot?: ReactNode;
  customSlotKey?: string;
};

export type EventRowViewModel = UserRowViewModel | AssistantRowViewModel;

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

const WebSearchBadge = () => (
  <div className="event-search-badge">
    <span className="event-search-badge-label">Search briefing</span>
  </div>
);

type UserRowProps = {
  row: UserRowViewModel;
  onOpenAttachment?: (attachment: Attachment) => void;
};

export const UserMessageRow = memo(
  function UserMessageRow({ row, onOpenAttachment }: UserRowProps) {
    const { text, windowLabel, attachments, channelEnvelope } = row;
    const windowPreviewImageUrl = sanitizeAttachmentImageUrl(
      row.windowPreviewImageUrl,
    );
    const reactionSummary = channelEnvelope
      ? summarizeReactions(channelEnvelope)
      : null;
    const hasChannelMeta = Boolean(channelEnvelope?.provider);

    return (
      <div
        className={`event-row event-row--user${row.justSent ? " event-row--user--just-sent" : ""}`}
      >
        <div className="event-item user">
          {windowLabel && (
            <span className="event-window-badge-hovercard">
              <span
                className="event-window-badge"
                tabIndex={windowPreviewImageUrl ? 0 : undefined}
              >
                {windowLabel}
              </span>
              {windowPreviewImageUrl && (
                <div className="event-window-preview" role="tooltip">
                  <img
                    src={windowPreviewImageUrl}
                    alt="Window content preview"
                    className="event-window-preview-img"
                  />
                </div>
              )}
            </span>
          )}
          {hasChannelMeta && (
            <div className="event-channel-meta">
              {channelEnvelope?.provider && (
                <span className="event-channel-badge provider">
                  {formatProvider(channelEnvelope.provider)}
                </span>
              )}
              {channelEnvelope && channelEnvelope.kind !== "message" && (
                <span className="event-channel-badge kind">
                  {formatChannelKind(channelEnvelope.kind)}
                </span>
              )}
              {channelEnvelope && reactionSummary && (
                <span className="event-channel-badge reaction">
                  {reactionSummary}
                </span>
              )}
            </div>
          )}
          {text.trim() && <UserMessageBody text={text} />}
          {attachments.length > 0 && (
            <div className="event-attachments">
              {attachments.map((attachment, index) => {
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
      </div>
    );
  },
  (prev, next) =>
    prev.onOpenAttachment === next.onOpenAttachment &&
    eventRowEqual(prev.row, next.row),
);

type AssistantRowProps = {
  row: AssistantRowViewModel;
};

export const AssistantMessageRow = memo(
  function AssistantMessageRow({ row }: AssistantRowProps) {
    const text = row.text;
    const hasText = text.trim().length > 0;
    const hasWebSearchBadge = Boolean(row.webSearchBadgeHtml?.trim());
    const hasOfficePreview = Boolean(row.officePreviewRef);
    const hasResource = Boolean(row.resourcePayload);
    const hasSelfMod = Boolean(row.selfModApplied);
    const hasAskQuestion = Boolean(row.askQuestion);
    const hasCustomSlot = Boolean(row.customSlot);

    if (
      !hasText &&
      !hasWebSearchBadge &&
      !hasOfficePreview &&
      !hasResource &&
      !hasSelfMod &&
      !hasAskQuestion &&
      !hasCustomSlot
    ) {
      return null;
    }

    return (
      <div
        className={`event-row event-row--assistant${row.isAnimating ? " event-row--streaming" : ""}`}
      >
        <div
          className={`event-item assistant${row.isAnimating ? " streaming" : ""}${!hasText && hasAskQuestion ? " event-item--ask-question-only" : ""}`}
        >
          {hasWebSearchBadge && <WebSearchBadge />}
          {hasText && (
            <Markdown
              text={text}
              cacheKey={row.cacheKey}
              isAnimating={row.isAnimating}
              enableEmotes={row.emotesEnabled}
            />
          )}
          {row.officePreviewRef && (
            <OfficePreviewCard previewRef={row.officePreviewRef} />
          )}
          {row.resourcePayload && (
            <EndResourceCard payload={row.resourcePayload} />
          )}
          {row.selfModApplied && (
            <SelfModUndoButton selfModApplied={row.selfModApplied} />
          )}
          {row.customSlot ? row.customSlot : null}
          {row.askQuestion && <AskQuestionBubble payload={row.askQuestion} />}
        </div>
      </div>
    );
  },
  (prev, next) => eventRowEqual(prev.row, next.row),
);

export const PendingAskQuestionRow = memo(function PendingAskQuestionRow({
  payload,
}: {
  payload: AskQuestionState;
}) {
  return (
    <div className="event-row event-row--assistant">
      <div className="event-item assistant event-item--ask-question-only">
        <AskQuestionBubble payload={payload} />
      </div>
    </div>
  );
});
