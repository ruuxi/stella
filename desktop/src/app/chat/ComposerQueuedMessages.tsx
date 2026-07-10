import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import { X } from "@/ui/icons";

const EXIT_MS = 100;

type VisibleItem = QueuedUserMessage & { leaving: boolean };

type ComposerQueuedMessagesProps = {
  messages: QueuedUserMessage[];
  /**
   * When provided, each queued bubble reveals an "X" on hover that cancels
   * just that message. The surface pairs removal from the queue with
   * restoring the bubble's text to its own composer input.
   */
  onCancel?: (message: QueuedUserMessage) => void;
};

/**
 * A single queued bubble. Splits into its own component so it can own a ref
 * to the bubble node and detect whether its clamped text actually overflows
 * — only overflowing bubbles get the soft bottom-fade truncation treatment,
 * so short queued messages keep a crisp bottom edge.
 */
function QueuedMessageBubble({
  item,
  onCancel,
}: {
  item: VisibleItem;
  onCancel?: (message: QueuedUserMessage) => void;
}) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const measure = () => {
      // `-webkit-line-clamp` caps the painted height, so an overflowing
      // bubble reports a taller scrollHeight than its clamped clientHeight.
      setTruncated(el.scrollHeight - el.clientHeight > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [item.text]);

  return (
    <div
      className={
        "composer-queued-message" +
        (item.leaving ? " composer-queued-message--leaving" : "")
      }
    >
      <div
        ref={bubbleRef}
        className={
          "composer-queued-message__bubble" +
          (truncated ? " composer-queued-message__bubble--truncated" : "")
        }
      >
        {item.text}
      </div>
      {onCancel && !item.leaving ? (
        <button
          type="button"
          className="composer-queued-message__cancel"
          aria-label="Cancel queued message"
          title="Cancel and edit"
          onClick={() => onCancel(item)}
        >
          <X size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function ComposerQueuedMessages({
  messages,
  onCancel,
}: ComposerQueuedMessagesProps) {
  const [visible, setVisible] = useState<VisibleItem[]>(() =>
    messages.map((message) => ({ ...message, leaving: false })),
  );
  const exitTimersRef = useRef(new Map<string, number>());

  useEffect(() => {
    const incomingById = new Map(messages.map((message) => [message.id, message]));

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
          next.push({ ...message, leaving: false });
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

  return (
    <div className="composer-queued-stack" aria-live="polite">
      {visible.map((item) => (
        <QueuedMessageBubble key={item.id} item={item} onCancel={onCancel} />
      ))}
    </div>
  );
}
