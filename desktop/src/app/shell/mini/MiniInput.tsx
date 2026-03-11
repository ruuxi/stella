import { useCallback, useEffect, useRef } from "react";
import type { ChatContext } from "@/types/electron";
import {
  resolveComposerContextState,
  resolveComposerPlaceholder,
} from "@/app/chat/composer-context";
import {
  PendingCaptureChip,
  ScreenshotContextChips,
  SelectedTextChip,
  WindowContextChip,
} from "@/app/chat/ComposerContextChips";

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
  onStop: () => void;
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
  onStop,
}: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (shellVisible) {
      inputRef.current?.focus();
    }
  }, [shellVisible]);

  const regionScreenshots = chatContext?.regionScreenshots ?? [];
  const isCapturePending = Boolean(chatContext?.capturePending);
  const composerContextState = resolveComposerContextState(
    chatContext,
    selectedText,
  );
  const hasScreenshots = composerContextState.hasScreenshotContext;

  const canSend =
    Boolean(message.trim()) || Boolean(selectedText) || hasScreenshots;

  const placeholder = resolveComposerPlaceholder({
    chatContext,
    contextState: composerContextState,
  });

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setMessage(e.target.value);
    },
    [setMessage],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Backspace" && !message && selectedText) {
        setSelectedText(null);
        setChatContext((prev) =>
          prev ? { ...prev, selectedText: null } : prev,
        );
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
    },
    [
      message,
      onSend,
      previewIndex,
      selectedText,
      setChatContext,
      setPreviewIndex,
      setSelectedText,
    ],
  );

  return (
    <div className="mini-composer">
      {chatContext?.window && (
        <WindowContextChip
          chatWindow={chatContext.window}
          setChatContext={setChatContext}
          className="mini-composer-window-badge"
          textClassName="mini-composer-window-text"
          removeClassName="mini-composer-window-dismiss"
          textFormatter={(chatWindow) => chatWindow.title || chatWindow.app}
        />
      )}

      {(hasScreenshots || isCapturePending) && (
        <div className="mini-composer-screenshots">
          <ScreenshotContextChips
            screenshots={regionScreenshots}
            setChatContext={setChatContext}
            onPreviewScreenshot={setPreviewIndex}
            chipClassName="mini-context-chip mini-context-chip--screenshot"
            imageClassName="mini-context-thumb"
            removeClassName="mini-context-remove"
          />
          {isCapturePending ? (
            <PendingCaptureChip
              className="mini-context-chip mini-context-chip--pending"
              innerClassName="mini-context-pending-inner"
            />
          ) : null}
        </div>
      )}

      <div className="mini-composer-inner">
        {selectedText && (
          <div className="mini-composer-context">
            <SelectedTextChip
              selectedText={selectedText}
              setSelectedText={setSelectedText}
              setChatContext={setChatContext}
              className="mini-context-chip mini-context-chip--text"
              textClassName="mini-context-text"
              removeClassName="mini-context-remove"
            />
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
                aria-label="Stop"
                onClick={onStop}
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
