import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "@/app/chat/Markdown";
import { MessageSquare } from "@/ui/icons";
import type { AgentThreadMessageRecord } from "../../../../runtime/contracts/local-chat.js";
import "./agent-thread-chat-tab.css";

const MESSAGE_LIMIT = 200;

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
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const list = window.electronAPI?.localChat?.listAgentThreadMessages;
    if (!list) {
      setError("Agent thread history is unavailable.");
      setLoading(false);
      return;
    }
    try {
      const next = await list({ threadId, limit: MESSAGE_LIMIT });
      if (generation !== requestGeneration.current) return;
      setMessages(next);
      setError(null);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setError(
        cause instanceof Error ? cause.message : "Couldn’t load this thread.",
      );
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    setMessages([]);
    setLoading(true);
    setError(null);
    void load();
    const unsubscribe =
      window.electronAPI?.localChat?.onThreadActivityUpdated?.((payload) => {
        if (payload.conversationId === conversationId) void load();
      });
    return () => {
      requestGeneration.current += 1;
      unsubscribe?.();
    };
  }, [conversationId, load]);

  return (
    <section
      className="agent-thread-chat"
      aria-label={`${agentType} read-only chat`}
      data-thread-id={threadId}
    >
      <header className="agent-thread-chat__header">
        <span className="agent-thread-chat__eyebrow">
          Read-only agent thread
        </span>
        <span className="agent-thread-chat__agent">{agentType}</span>
      </header>
      <div className="agent-thread-chat__scroll" aria-live="polite">
        {loading && messages.length === 0 ? (
          <div className="agent-thread-chat__state" role="status">
            Loading conversation…
          </div>
        ) : error && messages.length === 0 ? (
          <div className="agent-thread-chat__state" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>
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
      </div>
      <footer className="agent-thread-chat__readonly">
        This thread is read-only. Use the explicit follow-up action to send
        input.
      </footer>
    </section>
  );
}
