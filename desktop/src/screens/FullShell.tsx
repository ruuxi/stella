import { useState } from "react";
import { useMutation } from "convex/react";
import { useUiState } from "../app/state/ui-state";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../services/convex-api";
import { getOrCreateDeviceId } from "../services/device";
import { getOwnerId } from "../services/identity";
import { getElectronApi } from "../services/electron";
import type { UiMode } from "../types/ui";

const modes: UiMode[] = ['ask', 'chat', 'voice']

const modeCopy: Record<UiMode, string> = {
  ask: 'Ask includes a screenshot (no OCR).',
  chat: 'Chat is text-only.',
  voice: 'Voice uses speech-to-text.',
}

export const FullShell = () => {
  const { state, setMode, setConversationId, setWindow } = useUiState();
  const hostStatus = getElectronApi()
    ? "Local Host connected"
    : "Local Host disconnected";
  const [message, setMessage] = useState("");
  const appendEvent = useMutation(api.events.appendEvent);
  const createConversation = useMutation(api.conversations.createConversation);

  const sendMessage = () => {
    if (!state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = getOrCreateDeviceId();
    void appendEvent({
      conversationId: state.conversationId,
      type: "user_message",
      deviceId,
      payload: { text: message.trim() },
    });
    setMessage("");
  };

  const onNewConversation = () => {
    void createConversation({ ownerId: getOwnerId() }).then(
      (conversation: { _id?: string } | null) => {
        if (conversation?._id) {
          setConversationId(conversation._id);
        }
      },
    );
  };

  return (
    <div className="window-shell full">
      <header className="window-header">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
          <div className="header-subtitle">Full workspace</div>
          <div className="host-status">{hostStatus}</div>
        </div>
        <div className="header-actions">
          <div className="mode-toggle" role="tablist" aria-label="Assistant mode">
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                data-active={state.mode === mode}
                onClick={() => setMode(mode)}
              >
                {mode.toUpperCase()}
              </button>
            ))}
          </div>
          <button className="ghost-button" type="button" onClick={onNewConversation}>
            New thread
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => setWindow("mini")}
          >
            Collapse to Mini
          </button>
        </div>
      </header>

      <div className="full-body">
        <section className="panel chat-panel">
          <div className="panel-header">
            <div className="panel-title">Chat workspace</div>
            <div className="panel-meta">{state.conversationId ?? 'No conversation selected'}</div>
          </div>
          <div className="panel-content">
            <p className="panel-hint">{modeCopy[state.mode]}</p>
            {state.conversationId ? (
              <ConversationEvents conversationId={state.conversationId} />
            ) : (
              <div className="event-empty">Loading conversation…</div>
            )}
            <div className="composer">
              <input
                className="composer-input"
                placeholder="Compose a message or command..."
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    sendMessage();
                  }
                }}
                disabled={!state.conversationId}
              />
              <button
                className="primary-button"
                type="button"
                onClick={sendMessage}
                disabled={!state.conversationId}
              >
                Send
              </button>
            </div>
          </div>
        </section>

        <aside className="panel side-panel">
          <div className="panel-header">
            <div className="panel-title">Screens & context</div>
            <div className="panel-meta">Right panel</div>
          </div>
          <div className="panel-content">
            <div className="screen-card">
              <div className="screen-title">Active screen feed</div>
              <div className="screen-placeholder">Screens, captures, and tools land here.</div>
            </div>
            <div className="screen-card">
              <div className="screen-title">Agent status</div>
              <div className="screen-placeholder">General & Self-Modification agent queues.</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
