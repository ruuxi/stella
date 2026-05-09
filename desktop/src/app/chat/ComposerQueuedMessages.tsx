import { useEffect, useRef, useState } from "react";
import type { QueuedUserMessage } from "./hooks/use-streaming-chat";
import { QUEUED_USER_MESSAGE_EXIT_MS } from "./queued-message-timing";

type VisibleItem = QueuedUserMessage & { leaving: boolean };

type ComposerQueuedMessagesProps = {
  messages: QueuedUserMessage[];
};

export function ComposerQueuedMessages({
  messages,
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
          }, QUEUED_USER_MESSAGE_EXIT_MS);
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
        return a.timestamp - b.timestamp;
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
        <div
          key={item.id}
          className={
            "composer-queued-message" +
            (item.leaving ? " composer-queued-message--leaving" : "")
          }
        >
          <div className="composer-queued-message__bubble">{item.text}</div>
        </div>
      ))}
    </div>
  );
}
