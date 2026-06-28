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
import {
  Fragment,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AppWindowMac,
  ClipboardList,
  ClipboardPaste,
  Crop,
  Paperclip,
} from "@/ui/icons";
import {
  describePastedText,
  pastedTextPreview,
  type PastedTextDescriptor,
} from "@/features/chat/lib/paste-context";
import { ChipPreviewPortal } from "@/app/chat/ChipPreviewPortal";
import { useHoverPreview } from "@/app/chat/use-hover-preview";
import type {
  Attachment,
  ChannelEnvelope,
} from "@/features/chat/lib/event-transforms";
import { Markdown } from "@/app/chat/Markdown";
import { StreamingTextReveal } from "@/app/chat/StreamingTextReveal";
import {
  EndResourceCard,
  SourceDiffEndResource,
} from "@/app/chat/EndResourceCard";
import { InlineGeneratedImageStrip } from "@/app/chat/InlineGeneratedImageCard";
import { WebSearchResultsStrip } from "@/app/chat/WebSearchResultsStrip";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { ScheduleReceiptChip } from "@/app/chat/ScheduleReceiptChip";
import { BackgroundWorkCard } from "@/app/chat/BackgroundWorkCard";
import { ToolActivityTrace } from "@/app/chat/ToolActivityTrace";
import { SelfModUndoButton } from "@/app/chat/SelfModUndoButton";
import { VoiceSessionCard } from "@/app/chat/VoiceSessionCard";
import { sanitizeAttachmentImageUrl } from "@/shared/lib/url-safety";
import { UserMessageBody } from "@/app/chat/UserMessageBody";
import { MessageActions } from "@/app/chat/MessageActions";
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

/**
 * Window context chip inside the user bubble. The screenshot preview is
 * portaled to `document.body` (via `ChipPreviewPortal`) so it escapes the
 * scrolling chat container's clip rect — a plain absolutely-positioned
 * popover gets cropped to the message bubble / scroll viewport.
 */
function UserWindowContextChip({
  label,
  previewImageUrl,
}: {
  label: string;
  previewImageUrl?: string;
}) {
  const { triggerRef, open } = useHoverPreview<HTMLSpanElement>();
  return (
    <span className="event-window-badge-hovercard">
      <span
        ref={triggerRef}
        className="event-context-chip event-context-chip--window"
        data-has-preview={previewImageUrl ? "true" : undefined}
        tabIndex={previewImageUrl ? 0 : undefined}
      >
        <AppWindowMac
          className="event-context-chip__icon"
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="event-context-chip__label">{label}</span>
      </span>
      {previewImageUrl && (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open}
          preferredPlacement="top"
          className="event-window-preview-card"
        >
          <img
            src={previewImageUrl}
            alt="Window content preview"
            className="event-window-preview-img"
          />
        </ChipPreviewPortal>
      )}
    </span>
  );
}

/**
 * Pasted-text chip inside the user bubble. Mirrors the composer's
 * `PastedTextChip`: hovering (or focusing) reveals the pasted content in a
 * scrollable portaled card so the user can read what they attached. The
 * body comes from the bounded preview persisted on the message metadata.
 */
function UserPastedTextChip({
  descriptor,
}: {
  descriptor: PastedTextDescriptor;
}) {
  const { triggerRef, open, previewProps } = useHoverPreview<HTMLSpanElement>();
  const stats = describePastedText(descriptor);
  const preview = pastedTextPreview(descriptor);
  return (
    <span className="event-window-badge-hovercard">
      <span
        ref={triggerRef}
        className="event-context-chip event-context-chip--pasted-text"
        data-has-preview={preview ? "true" : undefined}
        tabIndex={preview ? 0 : undefined}
        title={`Pasted text — ${stats}`}
      >
        <ClipboardPaste
          className="event-context-chip__icon"
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="event-context-chip__label">Pasted text</span>
      </span>
      {preview && (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open}
          preferredPlacement="top"
          className="event-pasted-text-preview-card"
          {...previewProps}
        >
          <div className="event-pasted-text-preview-body">{preview}</div>
        </ChipPreviewPortal>
      )}
    </span>
  );
}

type ContextChip = { key: string; node: ReactNode };

// The chips sit above the bubble and are capped to the same 85% of the
// message-row column that the bubble uses (`.event-item.user max-width: 85%`),
// so the overflow math matches what the user sees. `CHIP_GAP` mirrors the
// chip row's `gap: 6px`.
const BUBBLE_MAX_FRACTION = 0.85;
const CHIP_GAP = 6;

/**
 * Lays out the user-bubble context chips on a single line. When they would
 * overflow the bubble's max width, the trailing chips collapse into a
 * "+N" pill; hovering / focusing it reveals the rest in a portaled popover
 * (portaled so it escapes the scrolling chat container's clip rect).
 */
function UserContextChips({ chips }: { chips: ContextChip[] }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  // The "+N" trigger mounts only after the measurement pass collapses chips,
  // so its hover listeners must be plain React props (a mount-time ref hook
  // would bind to a null element and never fire).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(chips.length);
  const signature = chips.map((chip) => chip.key).join("|");

  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure) return;
    const column = root.closest(".event-row") as HTMLElement | null;

    const compute = () => {
      const columnWidth = column?.clientWidth ?? root.clientWidth;
      const available = columnWidth * BUBBLE_MAX_FRACTION;
      const items = Array.from(measure.children) as HTMLElement[];
      if (items.length === 0) return;
      // Last measure child is the "+N" template; the rest map to `chips`.
      const overflowEl = items[items.length - 1];
      const chipEls = items.slice(0, items.length - 1);
      if (chipEls.length <= 1) {
        setVisibleCount(chipEls.length);
        return;
      }

      let total = 0;
      chipEls.forEach((el, index) => {
        total += el.offsetWidth + (index > 0 ? CHIP_GAP : 0);
      });
      if (total <= available) {
        setVisibleCount(chipEls.length);
        return;
      }

      const reserve = overflowEl.offsetWidth + CHIP_GAP;
      let used = 0;
      let count = 0;
      for (let index = 0; index < chipEls.length; index += 1) {
        const width = chipEls[index].offsetWidth + (index > 0 ? CHIP_GAP : 0);
        if (used + width + reserve <= available) {
          used += width;
          count += 1;
        } else {
          break;
        }
      }
      setVisibleCount(Math.max(1, count));
    };

    compute();
    const observer = new ResizeObserver(compute);
    if (column) observer.observe(column);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [signature]);

  const visible = chips.slice(0, visibleCount);
  const hidden = chips.slice(visibleCount);

  return (
    <div className="event-context-chips" ref={rootRef}>
      <div
        className="event-context-chips__measure"
        ref={measureRef}
        aria-hidden
      >
        {chips.map((chip) => (
          <Fragment key={chip.key}>{chip.node}</Fragment>
        ))}
        <span className="event-context-chip event-context-chip--overflow">
          +9
        </span>
      </div>
      {visible.map((chip) => (
        <Fragment key={chip.key}>{chip.node}</Fragment>
      ))}
      {hidden.length > 0 && (
        <>
          <button
            type="button"
            ref={triggerRef}
            className="event-context-chip event-context-chip--overflow"
            aria-label={`Show ${hidden.length} more`}
            onMouseEnter={() => setOverflowOpen(true)}
            onMouseLeave={() => setOverflowOpen(false)}
            onFocus={() => setOverflowOpen(true)}
            onBlur={() => setOverflowOpen(false)}
          >
            +{hidden.length}
          </button>
          <ChipPreviewPortal
            triggerRef={triggerRef}
            open={overflowOpen}
            preferredPlacement="top"
            className="event-context-overflow-card"
          >
            {hidden.map((chip) => (
              <Fragment key={chip.key}>{chip.node}</Fragment>
            ))}
          </ChipPreviewPortal>
        </>
      )}
    </div>
  );
}

type UserRowProps = {
  row: UserRowViewModel;
  onOpenAttachment?: (attachment: Attachment) => void;
};

export const UserMessageRow = memo(
  function UserMessageRow({ row, onOpenAttachment }: UserRowProps) {
    const { text, windowLabel, attachments, channelEnvelope } = row;
    const appSelectionLabel = row.appSelectionLabel?.trim();
    const activityLabel = row.activityLabel?.trim();
    const pastedTexts = row.pastedTexts ?? [];
    const windowPreviewImageUrl = sanitizeAttachmentImageUrl(
      row.windowPreviewImageUrl,
    );
    const reactionSummary = channelEnvelope
      ? summarizeReactions(channelEnvelope)
      : null;

    const chips: ContextChip[] = [];
    if (windowLabel) {
      chips.push({
        key: "window",
        node: (
          <UserWindowContextChip
            label={windowLabel}
            previewImageUrl={windowPreviewImageUrl ?? undefined}
          />
        ),
      });
    }
    if (appSelectionLabel) {
      chips.push({
        key: "app-selection",
        node: (
          <span className="event-context-chip event-context-chip--app-selection">
            <Crop
              className="event-context-chip__icon"
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="event-context-chip__label">
              {appSelectionLabel}
            </span>
          </span>
        ),
      });
    }
    if (activityLabel) {
      chips.push({
        key: "activity",
        node: (
          <span className="event-context-chip event-context-chip--activity">
            <ClipboardList
              className="event-context-chip__icon"
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="event-context-chip__label">{activityLabel}</span>
          </span>
        ),
      });
    }
    pastedTexts.forEach((descriptor, index) => {
      chips.push({
        key: `pasted-text-${index}`,
        node: <UserPastedTextChip descriptor={descriptor} />,
      });
    });
    if (channelEnvelope?.provider) {
      chips.push({
        key: "channel-provider",
        node: (
          <span className="event-channel-badge provider">
            {formatProvider(channelEnvelope.provider)}
          </span>
        ),
      });
    }
    if (channelEnvelope && channelEnvelope.kind !== "message") {
      chips.push({
        key: "channel-kind",
        node: (
          <span className="event-channel-badge kind">
            {formatChannelKind(channelEnvelope.kind)}
          </span>
        ),
      });
    }
    if (channelEnvelope && reactionSummary) {
      chips.push({
        key: "channel-reaction",
        node: (
          <span className="event-channel-badge reaction">
            {reactionSummary}
          </span>
        ),
      });
    }
    attachments.forEach((attachment, index) => {
      const safeUrl = sanitizeAttachmentImageUrl(attachment.url);
      const key = attachment.id ?? `attachment-${index}`;
      if (safeUrl) {
        chips.push({
          key,
          node: (
            <img
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
          ),
        });
        return;
      }
      chips.push({
        key,
        node: (
          <div className="event-attachment-fallback">
            <Paperclip
              className="event-attachment-fallback__icon"
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="event-attachment-fallback__label">
              {getAttachmentLabel(attachment, index)}
            </span>
          </div>
        ),
      });
    });

    return (
      <div
        className={`event-row event-row--user${row.justSent ? " event-row--user--just-sent" : ""}`}
      >
        {chips.length > 0 && <UserContextChips chips={chips} />}
        {text.trim() && (
          <>
            <div className="event-item user">
              <UserMessageBody text={text} />
            </div>
            <MessageActions text={text} messageKey={row.id} align="end" />
          </>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.onOpenAttachment === next.onOpenAttachment &&
    eventRowEqual(prev.row, next.row),
);

type AssistantRowProps = {
  row: AssistantRowViewModel;
  conversationId?: string | null;
};

export const AssistantMessageRow = memo(
  function AssistantMessageRow({ row, conversationId }: AssistantRowProps) {
    const text = row.text;
    const hasText = text.trim().length > 0;
    const hasOfficePreview = Boolean(row.officePreviewRef);
    const hasResource = Boolean(row.resourcePayload);
    const hasInlineImages = (row.inlineImagePayloads?.length ?? 0) > 0;
    const hasWebSearchResults = (row.webSearchResults?.length ?? 0) > 0;
    const hasSelfMod = Boolean(row.selfModApplied);
    const hasCustomSlot = Boolean(row.customSlot);
    const hasScheduleReceipt = Boolean(
      row.scheduleReceipt && row.scheduleReceipt.affected.length > 0,
    );
    const hasVoiceSession = Boolean(row.voiceSession);
    const hasBackgroundWork = Boolean(
      row.backgroundWork && row.backgroundWork.threadIds.length > 0,
    );
    const hasToolActivity = Boolean(
      row.toolActivity && row.toolActivity.steps.length > 0,
    );

    if (
      !hasText &&
      !hasOfficePreview &&
      !hasResource &&
      !hasInlineImages &&
      !hasWebSearchResults &&
      !hasSelfMod &&
      !hasCustomSlot &&
      !hasScheduleReceipt &&
      !hasVoiceSession &&
      !hasBackgroundWork &&
      !hasToolActivity
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
          {hasVoiceSession && row.voiceSession && (
            <VoiceSessionCard durationMs={row.voiceSession.durationMs} />
          )}
          {hasText && (
            <StreamingTextReveal active={Boolean(row.isStreaming)}>
              <Markdown
                text={text}
                cacheKey={row.cacheKey}
                hideHorizontalRules
              />
            </StreamingTextReveal>
          )}
          {hasToolActivity && row.toolActivity && (
            <ToolActivityTrace group={row.toolActivity} />
          )}
          {hasBackgroundWork && row.backgroundWork && (
            <BackgroundWorkCard
              threadIds={row.backgroundWork.threadIds}
              completedThreadIds={row.backgroundWork.completedThreadIds}
              supersededThreadIds={row.backgroundWork.supersededThreadIds}
              spawnedAtMs={row.backgroundWork.spawnedAtMs}
              descriptions={row.backgroundWork.descriptions}
              label={row.backgroundWork.label}
            />
          )}
          {hasWebSearchResults && row.webSearchResults && (
            <WebSearchResultsStrip results={row.webSearchResults} />
          )}
          {row.officePreviewRef && (
            <OfficePreviewCard previewRef={row.officePreviewRef} />
          )}
          {row.inlineImagePayloads && row.inlineImagePayloads.length > 0 ? (
            <InlineGeneratedImageStrip
              conversationId={conversationId}
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
          {hasText && !row.isStreaming && (
            <MessageActions
              text={text}
              messageKey={row.id}
              showReadAloud
              align="start"
            />
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.conversationId === next.conversationId &&
    eventRowEqual(prev.row, next.row),
);
