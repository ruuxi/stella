import { useCallback, useEffect, useRef } from "react";
import type { ChatContext } from "@/types/electron";
import {
  clearComposerSelectedTextContext,
  clearComposerWindowContext,
  removeComposerScreenshotContext,
  resolveComposerContextState,
  resolveComposerPlaceholder,
} from "@/app/chat/composer-context";

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

  const regionScreenshots = chatContext?.regionScreenshots ?? [];
  const isCapturePending = Boolean(chatContext?.capturePending);
  const composerContextState = resolveComposerContextState(chatContext, selectedText);
  const hasScreenshots = composerContextState.hasScreenshotContext;

  const canSend =
    Boolean(message.trim()) ||
    Boolean(selectedText) ||
    hasScreenshots;

  const clearWindowContext = useCallback(() => {
    clearComposerWindowContext(setChatContext);
  }, [setChatContext]);

  const clearSelectedTextContext = useCallback(() => {
    clearComposerSelectedTextContext(setSelectedText, setChatContext);
  }, [setSelectedText, setChatContext]);

  const removeScreenshotContext = useCallback((index: number) => {
    removeComposerScreenshotContext(index, setChatContext);
  }, [setChatContext]);

  const placeholder = resolveComposerPlaceholder({
    chatContext,
    contextState: composerContextState,
  });

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setMessage(e.target.value);
  }, [setMessage]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !message && selectedText) {
      clearSelectedTextContext();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
      return;
    }

    if (e.key === "Escape") {
      if (previewIndex !== null) {
        setPreviewIndex(null);
      } else {
        window.electronAPI?.window.close?.();
      }
    }
  }, [
    clearSelectedTextContext,
    message,
    onSend,
    previewIndex,
    selectedText,
    setPreviewIndex,
  ]);

  return (
    <div className="mini-composer">
      {chatContext?.window && (
        <div className="mini-composer-window-badge">
          <span className="mini-composer-window-text">
            {chatContext.window.title || chatContext.window.app}
          </span>
          <button
            type="button"
            className="mini-composer-window-dismiss"
            aria-label="Remove window context"
            onClick={clearWindowContext}
          >
            &times;
          </button>
        </div>
      )}

      {(hasScreenshots || isCapturePending) && (
        <div className="mini-composer-screenshots">
          {regionScreenshots.map((screenshot, index) => (
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
                  removeScreenshotContext(index);
                }}
              >
                &times;
              </button>
            </div>
          ))}
          {isCapturePending && (
            <div className="mini-context-chip mini-context-chip--pending">
              <div className="mini-context-pending-inner" />
            </div>
          )}
        </div>
      )}

      <div className="mini-composer-inner">
        {selectedText && (
          <div className="mini-composer-context">
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
                  clearSelectedTextContext();
                }}
              >
                &times;
              </button>
            </div>
          </div>
        )}

        <input
          ref={inputRef}
          className="mini-composer-input"
          placeholder={placeholder}
          value={message}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
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

