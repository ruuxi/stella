import { useState } from "react";
import { useUiState } from "../../app/state/ui-state";
import { useContextCapture } from "./use-context-capture";
import { useMiniChat } from "./use-mini-chat";
import { MiniInput } from "./MiniInput";
import { MiniOutput } from "./MiniOutput";

export const MiniShell = () => {
  const { setWindow } = useUiState();
  const [isStreaming, setIsStreaming] = useState(false);

  const {
    chatContext,
    setChatContext,
    selectedText,
    setSelectedText,
    shellVisible,
    previewIndex,
    setPreviewIndex,
  } = useContextCapture();

  const {
    message,
    setMessage,
    streamingText,
    reasoningText,
    pendingUserMessageId,
    expanded,
    events,
    sendMessage,
  } = useMiniChat({
    chatContext,
    selectedText,
    setChatContext,
    setSelectedText,
    isStreaming,
    setIsStreaming,
  });

  const hasConversation = events.length > 0 || Boolean(streamingText);
  const showConversation = expanded && hasConversation;

  const handleShellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      if (previewIndex !== null) {
        setPreviewIndex(null);
      } else {
        window.electronAPI?.closeWindow?.();
      }
    }
  };

  return (
    <div
      className={`raycast-shell${shellVisible ? " is-visible" : ""}`}
      onClick={handleShellClick}
    >
      <div className="raycast-panel">
        <MiniInput
          message={message}
          setMessage={setMessage}
          chatContext={chatContext}
          setChatContext={setChatContext}
          selectedText={selectedText}
          setSelectedText={setSelectedText}
          shellVisible={shellVisible}
          previewIndex={previewIndex}
          setPreviewIndex={setPreviewIndex}
          onSend={() => void sendMessage()}
          onExpand={() => setWindow("full")}
        />

        <MiniOutput
          events={events}
          streamingText={streamingText}
          reasoningText={reasoningText}
          isStreaming={isStreaming}
          pendingUserMessageId={pendingUserMessageId}
          showConversation={showConversation}
        />
      </div>

      {previewIndex !== null &&
        chatContext?.regionScreenshots?.[previewIndex] && (
          <div className="raycast-screenshot-overlay">
            <div className="raycast-screenshot-preview-container">
              <img
                src={chatContext.regionScreenshots[previewIndex].dataUrl}
                className="raycast-screenshot-preview"
                alt="Screenshot preview"
              />
              <button
                type="button"
                className="raycast-screenshot-close"
                onClick={() => setPreviewIndex(null)}
                aria-label="Close preview"
              >
                &times;
              </button>
            </div>
          </div>
        )}
    </div>
  );
};
