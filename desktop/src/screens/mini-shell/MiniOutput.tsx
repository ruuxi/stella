import { ConversationEvents } from "../ConversationEvents";
import type { EventRecord } from "../../hooks/use-conversation-events";

type Props = {
  events: EventRecord[];
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  showConversation: boolean;
};

export const MiniOutput = ({
  events,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  showConversation,
}: Props) => {
  return (
    <>
      {/* Results/conversation area.
          Keep the container mounted so its enter animation doesn't replay on every window show/hide. */}
      <div
        className={`raycast-results${showConversation ? " is-open" : ""}`}
      >
        {showConversation && (
          <div className="raycast-section">
            <div className="raycast-section-header">Conversation</div>
            <div className="raycast-conversation-content">
              <ConversationEvents
                events={events}
                maxItems={5}
                streamingText={streamingText}
                reasoningText={reasoningText}
                isStreaming={isStreaming}
                pendingUserMessageId={pendingUserMessageId}
              />
            </div>
          </div>
        )}
      </div>

      {/* Footer hint - only when streaming */}
      {showConversation && isStreaming && (
        <div className="raycast-footer">
          <div className="raycast-footer-hint">
            <kbd className="raycast-kbd-small">/queue</kbd>
            <span>to send next</span>
          </div>
        </div>
      )}
    </>
  );
};
