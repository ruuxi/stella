import { useEffect, useRef } from "react";
import type { ChatContext } from "../../types/electron";

type Props = {
  message: string;
  setMessage: (value: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  previewIndex: number | null;
  setPreviewIndex: (index: number | null) => void;
  isStreaming: boolean;
  shellVisible: boolean;
  onSend: () => void;
};

export const MiniInput = ({
  message,
  setMessage,
  chatContext,
  setChatContext,
  selectedText,
  setSelectedText,
  previewIndex,
  setPreviewIndex,
  isStreaming,
  shellVisible,
  onSend,
}: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (shellVisible) {
      inputRef.current?.focus();
    }
  }, [shellVisible]);

  const hasScreenshots = Boolean(chatContext?.regionScreenshots?.length);
  const hasContext =
    hasScreenshots ||
    Boolean(selectedText) ||
    Boolean(chatContext?.window) ||
    Boolean(chatContext?.capturePending);

  const canSend =
    Boolean(message.trim()) ||
    Boolean(selectedText) ||
    Boolean(chatContext?.regionScreenshots?.length);

  return (
    <div className="mini-composer">
      <div className="mini-composer-inner">
        {hasContext && (
          <div className="mini-composer-context">
            {chatContext?.regionScreenshots?.map((screenshot, index) => (
              <div
                key={index}
                className="mini-context-chip mini-context-chip--screenshot"
              >
                <img
                  src={screenshot.dataUrl}
                  className="mini-context-thumb"
                  alt={`Screenshot ${index + 1}`}
                  onClick={() => setPreviewIndex(index)}
                />
                <button
                  type="button"
                  className="mini-context-remove"
                  aria-label="Remove screenshot"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.electronAPI?.removeScreenshot?.(index);
                    setChatContext((prev) => {
                      if (!prev) return prev;
                      const next = [...(prev.regionScreenshots ?? [])];
                      next.splice(index, 1);
                      return { ...prev, regionScreenshots: next };
                    });
                  }}
                >
                  &times;
                </button>
              </div>
            ))}
            {chatContext?.capturePending && (
              <div className="mini-context-chip mini-context-chip--pending">
                <div className="mini-context-pending-inner" />
              </div>
            )}
            {selectedText && (
              <div className="mini-context-chip mini-context-chip--text">
                <span className="mini-context-text">
                  &ldquo;{selectedText}&rdquo;
                </span>
                <button
                  type="button"
                  className="mini-context-remove"
                  aria-label="Remove selected text"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedText(null);
                    setChatContext((prev) =>
                      prev ? { ...prev, selectedText: null } : prev,
                    );
                  }}
                >
                  &times;
                </button>
              </div>
            )}
            {chatContext?.window && (
              <div className="mini-context-chip mini-context-chip--window">
                <span className="mini-context-window">
                  {chatContext.window.app}
                  {chatContext.window.title
                    ? ` - ${chatContext.window.title}`
                    : ""}
                </span>
                <button
                  type="button"
                  className="mini-context-remove"
                  aria-label="Remove window context"
                  onClick={(e) => {
                    e.stopPropagation();
                    setChatContext((prev) =>
                      prev ? { ...prev, window: null } : prev,
                    );
                  }}
                >
                  &times;
                </button>
              </div>
            )}
          </div>
        )}

        <input
          ref={inputRef}
          className="mini-composer-input"
          placeholder={
            chatContext?.capturePending
              ? "Capturing screen..."
              : hasScreenshots
                ? "Ask about the capture..."
                : chatContext?.window
                  ? "Ask about this window..."
                  : selectedText
                    ? "Ask about the selection..."
                    : "Ask for follow-up changes"
          }
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !message && selectedText) {
              setSelectedText(null);
              setChatContext((prev) =>
                prev ? { ...prev, selectedText: null } : prev,
              );
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
            if (e.key === "Escape") {
              if (previewIndex !== null) {
                setPreviewIndex(null);
              } else {
                window.electronAPI?.closeWindow?.();
              }
            }
          }}
          autoFocus
        />

        <div className="mini-composer-actions">
          <div className="mini-composer-actions-left">
            <button type="button" className="mini-composer-add" title="Add">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <div className="mini-composer-actions-right">
            {isStreaming && (
              <button
                type="button"
                className="mini-composer-stop"
                title="Stop"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="mini-composer-send"
              onClick={onSend}
              disabled={!canSend}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
