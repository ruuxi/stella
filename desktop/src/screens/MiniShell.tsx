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

export const MiniShell = () => {
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
    <div className="window-shell mini">
      <div className="mini-top">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
          <span className="header-subtitle">Mini prompt</span>
          <span className="host-status">{hostStatus}</span>
        </div>
        <div className="mode-toggle compact" role="tablist" aria-label="Assistant mode">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={state.mode === mode}
              onClick={() => setMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => setWindow("full")}
        >
          Expand
        </button>
      </div>

      <div className="mini-input">
        <input
          className="composer-input"
          placeholder="Ask Stellar, search, or run a command..."
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
          className="ghost-button"
          type="button"
          onClick={sendMessage}
          disabled={!state.conversationId}
        >
          Send
        </button>
      </div>

      <div className="mini-thread">
        <div className="panel-header">
          <div className="panel-title">Thread</div>
          <div className="panel-meta">{state.conversationId ?? 'No conversation yet'}</div>
        </div>
        <div className="panel-content compact">
          {state.conversationId ? (
            <ConversationEvents conversationId={state.conversationId} maxItems={4} />
          ) : (
            <div className="event-empty">Loading conversation…</div>
          )}
          <button className="ghost-button" type="button" onClick={onNewConversation}>
            New thread
          </button>
        </div>
      </div>
    </div>
  )
}
