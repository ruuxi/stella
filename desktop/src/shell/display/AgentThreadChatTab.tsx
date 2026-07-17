import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Markdown } from "@/app/chat/Markdown";
import { MessageSquare } from "@/ui/icons";
import type { AgentThreadMessageRecord } from "../../../../runtime/contracts/local-chat.js";
import "./agent-thread-chat-tab.css";

const MESSAGE_LIMIT = 200;
const NEAR_BOTTOM_PX = 56;

const roleLabel = (role: AgentThreadMessageRecord["role"]): string => {
  switch (role) {
    case "user":
      return "Instruction";
    case "assistant":
      return "Agent";
    case "toolResult":
      return "Tool result";
    case "runtimeInternal":
      return "Coordination";
  }
};

const messageIdentity = (
  message: AgentThreadMessageRecord,
  index: number,
): string =>
  message.entryId ??
  `${message.timestamp}:${message.role}:${message.toolCallId ?? ""}:${message.content}:${index}`;

const countAppendedMessages = (
  previous: AgentThreadMessageRecord[],
  next: AgentThreadMessageRecord[],
): number => {
  if (previous.length === 0) return next.length;
  const previousLast = messageIdentity(
    previous[previous.length - 1]!,
    previous.length - 1,
  );
  const retainedIndex = next.findIndex(
    (message, index) => messageIdentity(message, index) === previousLast,
  );
  if (retainedIndex >= 0) return Math.max(0, next.length - retainedIndex - 1);

  const previousIds = new Set(
    previous.map((message, index) => messageIdentity(message, index)),
  );
  return next.reduce(
    (count, message, index) =>
      count + (previousIds.has(messageIdentity(message, index)) ? 0 : 1),
    0,
  );
};

const newestMessageAnnouncement = (
  messages: AgentThreadMessageRecord[],
  count: number,
): string => {
  const newest = messages.at(-1);
  if (!newest) return "";
  const preview = newest.content.replace(/\s+/g, " ").trim().slice(0, 140);
  if (!preview) {
    return `${count} new ${count === 1 ? "message" : "messages"}.`;
  }
  return `${count} new ${count === 1 ? "message" : "messages"}. Latest ${roleLabel(newest.role).toLowerCase()}: ${preview}`;
};

export function AgentThreadChatTab({
  threadId,
  conversationId,
  agentType,
}: {
  threadId: string;
  conversationId: string;
  agentType: string;
}) {
  const [messages, setMessages] = useState<AgentThreadMessageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const requestGeneration = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<AgentThreadMessageRecord[]>([]);
  const pinnedToLatestRef = useRef(true);
  const scrollToLatestAfterRenderRef = useRef(false);

  const load = useCallback(
    async (reason: "initial" | "refresh") => {
      const generation = ++requestGeneration.current;
      const list = window.electronAPI?.localChat?.listAgentThreadMessages;
      if (reason === "refresh") setRefreshing(true);
      if (!list) {
        setError("Agent thread history is unavailable.");
        setAnnouncement("");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      try {
        const next = await list({ threadId, limit: MESSAGE_LIMIT });
        if (generation !== requestGeneration.current) return;
        const previous = messagesRef.current;
        const appendedCount = countAppendedMessages(previous, next);
        const wasPinned = pinnedToLatestRef.current;
        messagesRef.current = next;
        setMessages(next);
        setError(null);
        if (reason === "initial") {
          pinnedToLatestRef.current = true;
          scrollToLatestAfterRenderRef.current = true;
          setNewMessageCount(0);
          setAnnouncement("");
        } else {
          if (wasPinned) {
            scrollToLatestAfterRenderRef.current = true;
            setNewMessageCount(0);
          }
          if (appendedCount > 0) {
            setAnnouncement(newestMessageAnnouncement(next, appendedCount));
          }
          if (!wasPinned && appendedCount > 0) {
            setNewMessageCount((count) => count + appendedCount);
          }
        }
      } catch (cause) {
        if (generation !== requestGeneration.current) return;
        const nextError =
          cause instanceof Error ? cause.message : "Couldn’t load this thread.";
        setError(nextError);
        // The visible error owns its focused live announcement through
        // `role=alert`; do not repeat it through the update status region.
        setAnnouncement("");
      } finally {
        if (generation === requestGeneration.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [threadId],
  );

  useEffect(() => {
    let disposed = false;
    let refreshQueued = false;
    let refreshInFlight = false;
    let refreshPending = false;
    const scheduleRefresh = () => {
      refreshPending = true;
      if (disposed || refreshQueued || refreshInFlight) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (disposed) return;
        refreshPending = false;
        refreshInFlight = true;
        void load("refresh").finally(() => {
          refreshInFlight = false;
          if (refreshPending && !disposed) scheduleRefresh();
        });
      });
    };

    messagesRef.current = [];
    pinnedToLatestRef.current = true;
    scrollToLatestAfterRenderRef.current = true;
    setMessages([]);
    setLoading(true);
    setRefreshing(false);
    setError(null);
    setNewMessageCount(0);
    setAnnouncement("");
    void load("initial");
    const unsubscribe =
      window.electronAPI?.localChat?.onThreadActivityUpdated?.((payload) => {
        if (
          payload.conversationId === conversationId &&
          payload.transcriptUpdate?.threadId === threadId
        ) {
          scheduleRefresh();
        }
      });
    return () => {
      disposed = true;
      requestGeneration.current += 1;
      unsubscribe?.();
    };
  }, [conversationId, load, threadId]);

  useLayoutEffect(() => {
    if (!scrollToLatestAfterRenderRef.current) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    scrollToLatestAfterRenderRef.current = false;
    scroll.scrollTop = scroll.scrollHeight;
    pinnedToLatestRef.current = true;
  }, [messages]);

  const handleScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const distanceFromBottom =
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    const pinned = distanceFromBottom <= NEAR_BOTTOM_PX;
    pinnedToLatestRef.current = pinned;
    if (pinned) setNewMessageCount(0);
  }, []);

  const showLatest = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = scroll.scrollHeight;
    pinnedToLatestRef.current = true;
    setNewMessageCount(0);
    setAnnouncement("Showing the newest message.");
  }, []);

  return (
    <section
      className="agent-thread-chat"
      aria-label={`${agentType} read-only chat`}
      data-thread-id={threadId}
      aria-busy={loading || refreshing}
    >
      <header className="agent-thread-chat__header">
        <span className="agent-thread-chat__eyebrow">
          Read-only agent thread
        </span>
        <span className="agent-thread-chat__agent">{agentType}</span>
      </header>
      {error && messages.length > 0 ? (
        <div
          className="agent-thread-chat__refresh-error"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <span>Couldn’t refresh this thread. {error}</span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void load("refresh")}
          >
            {refreshing ? "Retrying…" : "Try again"}
          </button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="agent-thread-chat__scroll"
        onScroll={handleScroll}
      >
        {loading && messages.length === 0 ? (
          <div className="agent-thread-chat__state" role="status">
            Loading conversation…
          </div>
        ) : error && messages.length === 0 ? (
          <div
            className="agent-thread-chat__state"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <span>{error}</span>
            <button type="button" onClick={() => void load("initial")}>
              Try again
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="agent-thread-chat__state">
            <MessageSquare size={22} strokeWidth={1.5} aria-hidden="true" />
            <span>No messages in this thread yet.</span>
          </div>
        ) : (
          <ol className="agent-thread-chat__messages">
            {messages.map((message, index) => (
              <li
                key={message.entryId ?? `${message.timestamp}:${index}`}
                className="agent-thread-chat__message"
                data-role={message.role}
              >
                <span className="agent-thread-chat__role">
                  {roleLabel(message.role)}
                </span>
                <div className="agent-thread-chat__body">
                  {message.role === "assistant" ? (
                    <Markdown
                      text={message.content}
                      cacheKey={message.entryId ?? `${threadId}:${index}`}
                      hideHorizontalRules
                    />
                  ) : (
                    message.content
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {newMessageCount > 0 ? (
          <button
            type="button"
            className="agent-thread-chat__new-messages"
            onClick={showLatest}
            aria-label={`Show ${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}`}
          >
            {newMessageCount} new{" "}
            {newMessageCount === 1 ? "message" : "messages"}
          </button>
        ) : null}
      </div>
      <p
        className="agent-thread-chat__announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
    </section>
  );
}
