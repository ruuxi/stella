import { useEffect } from "react";
import { useUiState } from "../../app/state/ui-state";
import { useContextCapture } from "./use-context-capture";
import { useMiniChat } from "./use-mini-chat";
import { MiniInput } from "./MiniInput";
import { MiniOutput } from "./MiniOutput";

type MiniShellProps = {
  onPreviewVisibilityChange?: (visible: boolean) => void;
};

export const MiniShell = ({ onPreviewVisibilityChange }: MiniShellProps) => {
  const { setWindow } = useUiState();

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
    isStreaming,
    pendingUserMessageId,
    events,
    sendMessage,
  } = useMiniChat({
    isActive: shellVisible || previewIndex !== null,
    chatContext,
    selectedText,
    setChatContext,
    setSelectedText,
  });

  const hasConversation = events.length > 0 || Boolean(streamingText);

  useEffect(() => {
    onPreviewVisibilityChange?.(previewIndex !== null);
    return () => onPreviewVisibilityChange?.(false);
  }, [onPreviewVisibilityChange, previewIndex]);

  useEffect(() => {
    if (!shellVisible) {
      return;
    }
    return window.electronAPI?.onVoiceTranscript?.((transcript) => {
      setMessage((prev) => (prev ? prev + ' ' + transcript : transcript));
    });
  }, [setMessage, shellVisible]);

  const windowTitle = chatContext?.window
    ? (chatContext.window.title || chatContext.window.app || null)
    : null;

  const handleShellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && previewIndex !== null) {
      setPreviewIndex(null);
    }
  };

  return (
    <div
      className={`raycast-shell${shellVisible ? " is-visible" : ""}${previewIndex !== null ? " has-preview" : ""}`}
      onClick={handleShellClick}
    >
      <div className="raycast-panel">
        <div className="mini-titlebar">
          <span className="mini-titlebar-title">
            {windowTitle ?? "Stella"}
          </span>
          <div className="mini-titlebar-right">
            <button
              className="mini-titlebar-action"
              type="button"
              onClick={() => setWindow("full")}
              title="Expand to full view"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            <button
              className="mini-titlebar-action"
              type="button"
              onClick={() => window.electronAPI?.closeWindow?.()}
              title="Close"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <MiniOutput
          events={events}
          streamingText={streamingText}
          reasoningText={reasoningText}
          isStreaming={isStreaming}
          pendingUserMessageId={pendingUserMessageId}
          showConversation={hasConversation}
        />

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
          isStreaming={isStreaming}
          onSend={() => void sendMessage()}
        />
      </div>

      {previewIndex !== null &&
        chatContext?.regionScreenshots?.[previewIndex] && (
          <div
            className="raycast-screenshot-overlay"
            onClick={() => setPreviewIndex(null)}
          >
            <div
              className="raycast-screenshot-preview-container"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={chatContext.regionScreenshots[previewIndex].dataUrl}
                className="raycast-screenshot-preview"
                alt="Screenshot preview"
              />
              <button
                type="button"
                className="raycast-screenshot-close"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setPreviewIndex(null);
                }}
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
