import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import { X } from "@/ui/icons";
import {
  hasQueuedMessageEntryPlayed,
  markQueuedMessageEntryPlayed,
} from "@/features/chat/lib/message-entry-animation-state";
import { ChipPreviewPortal } from "./ChipPreviewPortal";
import { useHoverPreview } from "./use-hover-preview";

const EXIT_MS = 100;

type VisibleItem = QueuedUserMessage & { leaving: boolean };

/**
 * Legend may reconstruct a keyed virtual item while adjacent streaming rows
 * and measurements settle. Keep the playback record outside the item subtree
 * so that reconstruction cannot replay the queued bubble's CSS animation.
 * Message ids are renderer-owned and remain stable through queue reconciliation
 * and the queued-to-sent handoff.
 */
const toVisibleItem = (message: QueuedUserMessage): VisibleItem => ({
  ...message,
  leaving: false,
});

type ComposerQueuedMessagesProps = {
  messages: QueuedUserMessage[];
  /**
   * When provided, the single-message bubble or each collapsed-preview row
   * can cancel that message and restore its text to the composer.
   */
  onCancel?: (message: QueuedUserMessage) => void;
};

/**
 * The one visible queue bubble. A single message shows its text unchanged;
 * multiple messages collapse into a count whose hover/focus preview reuses
 * the composer's pasted-text preview portal and floating surface.
 */
function QueuedMessageBubble({
  items,
  entering,
  leaving,
  onCancel,
}: {
  items: VisibleItem[];
  entering: boolean;
  leaving: boolean;
  onCancel?: (message: QueuedUserMessage) => void;
}) {
  const { triggerRef, open, previewProps } =
    useHoverPreview<HTMLButtonElement>();
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const collapsed = items.length > 1;
  const first = items[0]!;
  const label = collapsed ? `${items.length} messages queued` : first.text;

  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el || collapsed) {
      setTruncated(false);
      return undefined;
    }
    const measure = () => {
      // `-webkit-line-clamp` caps the painted height, so an overflowing
      // bubble reports a taller scrollHeight than its clamped clientHeight.
      setTruncated(el.scrollHeight - el.clientHeight > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsed, first.text]);

  const bubbleClassName =
    "composer-queued-message__bubble" +
    (collapsed ? " composer-queued-message__bubble--summary" : "") +
    (truncated ? " composer-queued-message__bubble--truncated" : "");

  return (
    <div
      style={!entering && !leaving ? { animation: "none" } : undefined}
      className={
        "composer-queued-message" +
        (leaving ? " composer-queued-message--leaving" : "")
      }
    >
      {collapsed ? (
        <button
          ref={triggerRef}
          type="button"
          className={bubbleClassName}
          aria-label={`${label}. Preview queued messages`}
          aria-expanded={open}
          aria-haspopup="true"
        >
          {label}
        </button>
      ) : (
        <div ref={bubbleRef} className={bubbleClassName}>
          {label}
        </div>
      )}
      {onCancel && !leaving && !collapsed ? (
        <button
          type="button"
          className="composer-queued-message__cancel"
          aria-label="Cancel queued message"
          title="Cancel and edit"
          onClick={() => onCancel(first)}
        >
          <X size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      ) : null}
      {collapsed ? (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open}
          className="composer-context-preview composer-context-preview--portal composer-queued-preview"
          {...previewProps}
        >
          <ol className="composer-queued-preview__list">
            {items.map((item, index) => (
              <li className="composer-queued-preview__item" key={item.id}>
                <span className="composer-queued-preview__number">
                  {index + 1}
                </span>
                <span className="composer-queued-preview__text">
                  {item.text}
                </span>
                {onCancel ? (
                  <button
                    type="button"
                    className="composer-queued-preview__cancel"
                    aria-label={`Cancel queued message ${index + 1}`}
                    title="Cancel and edit"
                    onClick={() => onCancel(item)}
                  >
                    <X size={14} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </ChipPreviewPortal>
      ) : null}
    </div>
  );
}

export function ComposerQueuedMessages({
  messages,
  onCancel,
}: ComposerQueuedMessagesProps) {
  // Latched for this virtual-item mount. Every represented id is registered
  // after commit, so a Legend reconstruction settles immediately while a
  // count update on the existing collapsed bubble cannot restart animation.
  const enteringRef = useRef(
    messages.some((message) => !hasQueuedMessageEntryPlayed(message.id)),
  );
  const [visible, setVisible] = useState<VisibleItem[]>(() =>
    messages.map(toVisibleItem),
  );
  const exitTimersRef = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    for (const message of messages) {
      markQueuedMessageEntryPlayed(message.id);
    }
  }, [messages]);

  useEffect(() => {
    const incomingById = new Map(
      messages.map((message) => [message.id, message]),
    );

    setVisible((current) => {
      const seenIds = new Set<string>();
      const next: VisibleItem[] = [];

      for (const item of current) {
        const fresh = incomingById.get(item.id);
        if (fresh) {
          seenIds.add(item.id);
          const exitTimer = exitTimersRef.current.get(item.id);
          if (exitTimer) {
            window.clearTimeout(exitTimer);
            exitTimersRef.current.delete(item.id);
          }
          next.push({ ...fresh, leaving: false });
          continue;
        }

        if (item.leaving) {
          next.push(item);
          continue;
        }

        next.push({ ...item, leaving: true });
        if (!exitTimersRef.current.has(item.id)) {
          const timeoutId = window.setTimeout(() => {
            exitTimersRef.current.delete(item.id);
            setVisible((entries) =>
              entries.filter((entry) => entry.id !== item.id),
            );
          }, EXIT_MS);
          exitTimersRef.current.set(item.id, timeoutId);
        }
      }

      for (const message of messages) {
        if (!seenIds.has(message.id)) {
          next.push(toVisibleItem(message));
        }
      }

      next.sort((a, b) => {
        if (a.leaving !== b.leaving) {
          return a.leaving ? -1 : 1;
        }
        return a.queueOrder - b.queueOrder || a.timestamp - b.timestamp;
      });
      return next;
    });
  }, [messages]);

  useEffect(
    () => () => {
      for (const timeoutId of exitTimersRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      exitTimersRef.current.clear();
    },
    [],
  );

  if (visible.length === 0) return null;

  const active = visible.filter((item) => !item.leaving);
  const displayed = active.length > 0 ? active : visible.slice(0, 1);

  return (
    <div
      className="composer-queued-stack"
      aria-live="polite"
      data-queue-count={active.length}
    >
      <QueuedMessageBubble
        items={displayed}
        entering={enteringRef.current}
        leaving={active.length === 0}
        onCancel={onCancel}
      />
    </div>
  );
}
