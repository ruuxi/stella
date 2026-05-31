/**
 * Linear chat row components.
 *
 * Each message renders as a single row in chronological order, with no
 * per-turn user/assistant grouping. Tool-derived artifacts (web-search
 * badge, office preview, end-resource pill, self-mod undo) attach to
 * the assistant row that immediately followed the producing tool events.
 *
 * Streaming is NOT a separate row: live stream chunks update an
 * in-memory `MessageRecord` overlay that `useConversationDisplayMessages`
 * merges into the displayed list under a stable
 * `assistant-{userMessageId}-{indexInTurn}` key. When the persisted
 * `assistant_message` lands, the overlay remains the visible text
 * source while borrowing persisted metadata/tool events; when the
 * overlay later clears, the persisted row reuses the same React key.
 * The only marker that the row is currently receiving chunks is
 * `isStreaming` below (styling). Scroll follow is driven by runtime
 * `assistantScrollFollowKey` signals and `data-scroll-follow-key` on
 * the row.
 *
 * Reasoning text is intentionally NOT rendered anywhere in this surface
 * (the underlying data still flows through state for model history).
 */
import { memo } from "react";
import type {
  Attachment,
  ChannelEnvelope,
} from "@/features/chat/lib/event-transforms";
import { Markdown } from "@/app/chat/Markdown";
import {
  EndResourceCard,
  SourceDiffEndResource,
} from "@/app/chat/EndResourceCard";
import { InlineGeneratedImageStrip } from "@/app/chat/InlineGeneratedImageCard";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { ScheduleReceiptChip } from "@/app/chat/ScheduleReceiptChip";
import { SelfModUndoButton } from "@/app/chat/SelfModUndoButton";
import { sanitizeAttachmentImageUrl } from "@/shared/lib/url-safety";
import { UserMessageBody } from "@/app/chat/UserMessageBody";
import { eventRowEqual } from "@/features/chat/lib/row-equality";
import type {
  AssistantRowViewModel,
  UserRowViewModel,
} from "@/features/chat/conversation-row-types";

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

type UserRowProps = {
  row: UserRowViewModel;
  onOpenAttachment?: (attachment: Attachment) => void;
};

export const UserMessageRow = memo(
  function UserMessageRow({ row, onOpenAttachment }: UserRowProps) {
    const { text, windowLabel, attachments, channelEnvelope } = row;
    const appSelectionLabel = row.appSelectionLabel?.trim();
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
          {appSelectionLabel && (
            <span className="event-window-badge event-window-badge--app-selection">
              {appSelectionLabel}
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
    const hasOfficePreview = Boolean(row.officePreviewRef);
    const hasResource = Boolean(row.resourcePayload);
    const hasInlineImages = (row.inlineImagePayloads?.length ?? 0) > 0;
    const hasSelfMod = Boolean(row.selfModApplied);
    const hasCustomSlot = Boolean(row.customSlot);
    const hasScheduleReceipt = Boolean(
      row.scheduleReceipt && row.scheduleReceipt.affected.length > 0,
    );

    if (
      !hasText &&
      !hasOfficePreview &&
      !hasResource &&
      !hasInlineImages &&
      !hasSelfMod &&
      !hasCustomSlot &&
      !hasScheduleReceipt
    ) {
      // Reserve a scroll-follow target before the first token lands;
      // otherwise `followActiveAssistantRow` can't find
      // `[data-scroll-follow-key]` and auto-follow waits on ResizeObserver
      // luck.
      if (row.isStreaming) {
        return (
          <div
            className="event-row event-row--assistant event-row--streaming"
            data-scroll-follow-key={row.id}
            aria-hidden
          >
            <div className="event-item assistant event-item--streaming-placeholder" />
          </div>
        );
      }
      return null;
    }

    return (
      <div
        className={`event-row event-row--assistant${row.isStreaming ? " event-row--streaming" : ""}`}
        data-scroll-follow-key={row.id}
      >
        <div className="event-item assistant">
          {hasText && (
            <Markdown
              text={text}
              cacheKey={row.cacheKey}
              hideHorizontalRules
            />
          )}
          {row.officePreviewRef && (
            <OfficePreviewCard previewRef={row.officePreviewRef} />
          )}
          {row.inlineImagePayloads && row.inlineImagePayloads.length > 0 ? (
            <InlineGeneratedImageStrip
              payloads={row.inlineImagePayloads.filter(
                (
                  payload,
                ): payload is Extract<DisplayPayload, { kind: "media" }> =>
                  payload.kind === "media" &&
                  payload.presentation === "inline-image" &&
                  payload.asset.kind === "image",
              )}
            />
          ) : null}
          {row.sourceDiffPayloads && row.sourceDiffPayloads.length > 0 ? (
            <SourceDiffEndResource
              batchId={row.id}
              payloads={row.sourceDiffPayloads}
            />
          ) : row.resourcePayload ? (
            <EndResourceCard payload={row.resourcePayload} />
          ) : null}
          {row.selfModApplied && (
            <SelfModUndoButton selfModApplied={row.selfModApplied} />
          )}
          {hasScheduleReceipt && row.scheduleReceipt && (
            <ScheduleReceiptChip
              affected={row.scheduleReceipt.affected}
              summary={row.scheduleReceipt.summary}
            />
          )}
          {row.customSlot ? row.customSlot : null}
        </div>
      </div>
    );
  },
  (prev, next) => eventRowEqual(prev.row, next.row),
);
