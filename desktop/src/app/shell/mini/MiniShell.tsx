import { useCallback, useEffect } from "react";
import { useUiState } from "@/providers/ui-state";
import { useContextCapture } from "./use-context-capture";
import { useMiniChat } from "./use-mini-chat";
import { MiniInput } from "./MiniInput";
import { MiniOutput } from "./MiniOutput";
import "./mini-shell.css";

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
  const previewScreenshot =
    previewIndex !== null ? chatContext?.regionScreenshots?.[previewIndex] : null;
  const hasPreview = previewIndex !== null;

  useEffect(() => {
    onPreviewVisibilityChange?.(hasPreview);
  }, [hasPreview, onPreviewVisibilityChange]);

  useEffect(() => {
    return () => onPreviewVisibilityChange?.(false);
  }, [onPreviewVisibilityChange]);

  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      setMessage((prev) => (prev ? `${prev} ${transcript}` : transcript));
    },
    [setMessage],
  );

  useEffect(() => {
    if (!shellVisible) {
      return;
    }
    return window.electronAPI?.voice.onTranscript?.(handleVoiceTranscript);
  }, [handleVoiceTranscript, shellVisible]);

  const windowTitle = chatContext?.window
    ? (chatContext.window.title || chatContext.window.app || null)
    : null;

  const handleShellClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && hasPreview) {
      setPreviewIndex(null);
    }
  }, [hasPreview, setPreviewIndex]);
  const handleExpandWindow = useCallback(() => {
    setWindow("full");
  }, [setWindow]);
  const handleCloseWindow = useCallback(() => {
    window.electronAPI?.window.close?.();
  }, []);
  const handleSend = useCallback(() => {
    void sendMessage();
  }, [sendMessage]);
  const closePreview = useCallback(() => {
    setPreviewIndex(null);
  }, [setPreviewIndex]);
  const stopPreviewPropagation = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);
  const handlePreviewClose = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    closePreview();
  }, [closePreview]);

  return (
    <div
      className={`raycast-shell${shellVisible ? " is-visible" : ""}${hasPreview ? " has-preview" : ""}`}
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
              onClick={handleExpandWindow}
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
              onClick={handleCloseWindow}
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
          onSend={handleSend}
        />
      </div>

      {previewScreenshot && (
        <div
          className="raycast-screenshot-overlay"
          onClick={closePreview}
        >
          <div
            className="raycast-screenshot-preview-container"
            onClick={stopPreviewPropagation}
          >
            <img
              src={previewScreenshot.dataUrl}
              className="raycast-screenshot-preview"
              alt="Screenshot preview"
            />
            <button
              type="button"
              className="raycast-screenshot-close"
              onClick={handlePreviewClose}
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


