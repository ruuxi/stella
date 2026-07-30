import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown } from "@/app/chat/Markdown";
import { BackgroundWorkCard } from "@/app/chat/BackgroundWorkCard";
import { AgentCompletionCard } from "@/app/chat/AgentCompletionCard";
import {
  buildBackgroundTaskLifecycleIndex,
  type BackgroundTaskCardState,
  type BackgroundTaskLifecycleIndex,
} from "@/features/chat/lib/background-task-lifecycle";
import { isAgentStartedEvent } from "@/features/chat/lib/event-transforms";
import { useThreadActivity } from "@/features/chat/hooks/use-thread-activity";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
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
    case "lifecycle":
      return "Activity";
  }
};

const ThreadLifecycleCard = ({
  state,
  index,
  conversationId,
  modelConfigByThread,
}: {
  state: BackgroundTaskCardState;
  index: BackgroundTaskLifecycleIndex;
  conversationId: string;
  modelConfigByThread: AgentModelConfigsByThread;
}) => {
  if (state.status === "completed" && state.completion) {
    return (
      <AgentCompletionCard
        sections={[state.completion]}
        cardId={state.cardId}
        conversationId={conversationId}
        modelConfigByThread={modelConfigByThread}
      />
    );
  }
  const superseded = [...index.byStartEventId.values()].some(
    (candidate) =>
      candidate.agentId === state.agentId &&
      candidate.startEventId !== state.startEventId &&
      (candidate.attemptGeneration !== undefined &&
      state.attemptGeneration !== undefined
        ? candidate.attemptGeneration > state.attemptGeneration
        : candidate.startedAtMs > state.startedAtMs),
  );
  return (
    <BackgroundWorkCard
      threadIds={[state.agentId]}
      completedThreadIds={state.status === "completed" ? [state.agentId] : []}
      pausedThreadIds={state.status === "canceled" ? [state.agentId] : []}
      failedThreadIds={state.status === "failed" ? [state.agentId] : []}
      supersededThreadIds={superseded ? [state.agentId] : []}
      spawnedAtMs={{ [state.agentId]: state.startedAtMs }}
      descriptions={{ [state.agentId]: state.title }}
      statusTexts={state.isFollowUp ? { [state.agentId]: state.title } : {}}
      followUpThreadIds={state.isFollowUp ? [state.agentId] : []}
      cardId={state.cardId}
      startEventIdsByThread={{ [state.agentId]: state.startEventId }}
      attemptGenerationsByThread={
        state.attemptGeneration !== undefined
          ? { [state.agentId]: state.attemptGeneration }
          : {}
      }
      rootRunIdsByThread={
        state.rootRunId ? { [state.agentId]: state.rootRunId } : {}
      }
      terminalEventIdsByThread={
        state.terminalEventId ? { [state.agentId]: state.terminalEventId } : {}
      }
      conversationId={conversationId}
    />
  );
};

const messageIdentity = (
  message: AgentThreadMessageRecord,
  index: number,
): string =>
  message.entryId ??
  `${message.timestamp}:${message.role}:${message.lifecycleEvent?._id ?? ""}:${message.content}:${index}`;

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
  const { records: threadActivity } = useThreadActivity(conversationId);
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
  const lifecycleIndex = useMemo(
    () =>
      buildBackgroundTaskLifecycleIndex(
        messages.flatMap((message) =>
          message.role === "lifecycle" && message.lifecycleEvent
            ? [message.lifecycleEvent]
            : [],
        ),
      ),
    [messages],
  );
  const modelConfigByThread = useMemo<AgentModelConfigsByThread>(
    () =>
      Object.fromEntries(
        threadActivity.map((record) => [
          record.threadId,
          record.modelConfigSnapshot,
        ]),
      ),
    [threadActivity],
  );
  const visibleMessages = useMemo(
    () =>
      messages.filter((message) => {
        if (message.role !== "lifecycle") return true;
        return Boolean(
          message.lifecycleEvent &&
            isAgentStartedEvent(message.lifecycleEvent) &&
            lifecycleIndex.byStartEventId.has(message.lifecycleEvent._id),
        );
      }),
    [lifecycleIndex, messages],
  );

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
        if (payload.conversationId !== conversationId) return;
        const exactThreadId =
          payload.transcriptUpdate?.threadId ??
          payload.assistantUpdate?.threadId;
        // Transcript/authored-update pushes identify their exact thread.
        // Lifecycle persistence also emits a conversation-level invalidation
        // with no thread id; refresh the one visible viewer for that signal so
        // external-engine/finalization writes cannot leave it frozen.
        if (exactThreadId && exactThreadId !== threadId) return;
        scheduleRefresh();
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
        ) : visibleMessages.length === 0 ? (
          <div className="agent-thread-chat__state">
            <MessageSquare size={22} strokeWidth={1.5} aria-hidden="true" />
            <span>No messages in this thread yet.</span>
          </div>
        ) : (
          // `chat-conversation-surface--sidebar` reuses the panel chat's
          // shared bubble styling (see compact-conversation.css) so this
          // read-only view renders exactly like the normal sidebar chat.
          <ol className="agent-thread-chat__messages chat-conversation-surface chat-conversation-surface--sidebar">
            {visibleMessages.map((message, index) => (
              <li
                key={message.entryId ?? `${message.timestamp}:${index}`}
                className="agent-thread-chat__message"
                data-role={message.role}
              >
                {message.role === "lifecycle" && message.lifecycleEvent ? (
                  <ThreadLifecycleCard
                    state={
                      lifecycleIndex.byStartEventId.get(
                        message.lifecycleEvent._id,
                      )!
                    }
                    index={lifecycleIndex}
                    conversationId={conversationId}
                    modelConfigByThread={modelConfigByThread}
                  />
                ) : (
                  <>
                    <span className="agent-thread-chat__role">
                      {roleLabel(message.role)}
                    </span>
                    {message.role === "assistant" ? (
                      <div className="event-item assistant">
                        <Markdown
                          text={message.content}
                          cacheKey={message.entryId ?? `${threadId}:${index}`}
                          hideHorizontalRules
                        />
                      </div>
                    ) : (
                      <div className="event-item user">
                        <div className="event-body">{message.content}</div>
                      </div>
                    )}
                  </>
                )}
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
