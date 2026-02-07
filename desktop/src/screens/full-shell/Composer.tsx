/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */

import { useRef, useState } from "react";
import type { ChatContext } from "../../types/electron";

type ComposerProps = {
  message: string;
  setMessage: (message: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  isStreaming: boolean;
  queueNext: boolean;
  setQueueNext: (value: boolean) => void;
  canSubmit: boolean;
  conversationId: string | null;
  onSend: () => void;
};

export function Composer({
  message,
  setMessage,
  chatContext,
  setChatContext,
  selectedText,
  setSelectedText,
  isStreaming,
  queueNext,
  setQueueNext,
  canSubmit,
  conversationId,
  onSend,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);

  const hasScreenshotContext = Boolean(chatContext?.regionScreenshots?.length);
  const hasWindowContext = Boolean(chatContext?.window);
  const hasSelectedTextContext = Boolean(selectedText);
  const hasComposerContext = Boolean(
    hasScreenshotContext ||
      hasWindowContext ||
      hasSelectedTextContext ||
      chatContext?.capturePending,
  );

  return (
    <div className="composer">
      <form
        className={`composer-form${composerExpanded || hasComposerContext ? " expanded" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <button type="button" className="composer-add-button" title="Add">
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

        {hasComposerContext && (
          <div className="composer-context-row">
            {chatContext?.regionScreenshots?.map((screenshot, index) => (
              <div
                key={index}
                className="composer-context-chip composer-context-chip--screenshot"
              >
                <img
                  src={screenshot.dataUrl}
                  className="composer-context-thumb"
                  alt={`Screenshot ${index + 1}`}
                />
                <button
                  type="button"
                  className="composer-context-remove"
                  aria-label="Remove screenshot"
                  onClick={(event) => {
                    event.stopPropagation();
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
              <div className="composer-context-chip composer-context-chip--pending">
                <div className="composer-context-pending-inner" />
              </div>
            )}
            {selectedText && (
              <div className="composer-context-chip composer-context-chip--text">
                <span className="composer-context-text">
                  &quot;{selectedText}&quot;
                </span>
                <button
                  type="button"
                  className="composer-context-remove"
                  aria-label="Remove selected text"
                  onClick={(event) => {
                    event.stopPropagation();
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
              <div className="composer-context-chip composer-context-chip--window">
                <span className="composer-context-window">
                  {chatContext.window.app}
                  {chatContext.window.title
                    ? ` - ${chatContext.window.title}`
                    : ""}
                </span>
                <button
                  type="button"
                  className="composer-context-remove"
                  aria-label="Remove window context"
                  onClick={(event) => {
                    event.stopPropagation();
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

        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={
            chatContext?.capturePending
              ? "Capturing screen..."
              : hasScreenshotContext
                ? "Ask about the capture..."
                : hasWindowContext
                  ? "Ask about this window..."
                  : hasSelectedTextContext
                    ? "Ask about the selection..."
                    : "Ask anything"
          }
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (!el) return;
              const form = el.closest(".composer-form") as HTMLElement | null;
              if (!form) return;
              const isExpanded = form.classList.contains("expanded");

              if (!isExpanded) {
                if (el.scrollHeight > 44) setComposerExpanded(true);
              } else {
                form.classList.remove("expanded");
                const pillSh = el.scrollHeight;
                form.classList.add("expanded");
                if (pillSh <= 44) setComposerExpanded(false);
              }
            });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          disabled={!conversationId}
          rows={1}
        />

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <button
              type="button"
              className="composer-add-button composer-add-button--toolbar"
              title="Add"
            >
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
            {isStreaming && (
              <button
                type="button"
                className="composer-selector"
                data-active={queueNext ? "true" : "false"}
                onClick={() => setQueueNext(!queueNext)}
                title="Queue the next message to send after the current response"
              >
                <span>Queue</span>
              </button>
            )}
          </div>

          <div className="composer-toolbar-right">
            <button
              type="submit"
              className="composer-submit"
              disabled={!canSubmit}
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
      </form>
    </div>
  );
}
