import { StellaAnimation } from "../../components/StellaAnimation";
import type { ChatContext } from "../../types/electron";

type Props = {
  message: string;
  setMessage: (value: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  shellVisible: boolean;
  previewIndex: number | null;
  setPreviewIndex: (index: number | null) => void;
  onSend: () => void;
  onExpand: () => void;
};

export const MiniInput = ({
  message,
  setMessage,
  chatContext,
  setChatContext,
  selectedText,
  setSelectedText,
  shellVisible,
  previewIndex,
  setPreviewIndex,
  onSend,
  onExpand,
}: Props) => {
  return (
    <div className="raycast-header">
      <div className="raycast-search">
        <div className="raycast-search-icon">
          <StellaAnimation width={32} height={32} paused={!shellVisible} />
        </div>
        <div className="raycast-input-wrap">
          {chatContext?.regionScreenshots?.map((screenshot, index) => (
            <div key={index} className="raycast-screenshot-chip">
              <img
                src={screenshot.dataUrl}
                className="raycast-screenshot-thumb"
                alt={`Screenshot ${index + 1}`}
                onClick={() => setPreviewIndex(index)}
              />
              <button
                type="button"
                className="raycast-screenshot-dismiss"
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
            <div className="raycast-screenshot-chip raycast-screenshot-skeleton">
              <div className="raycast-screenshot-skeleton-inner" />
            </div>
          )}
          {selectedText && (
            <div className="raycast-selected-text-chip">
              <span className="raycast-selected-text">
                &ldquo;{selectedText}&rdquo;
              </span>
              <button
                type="button"
                className="raycast-screenshot-dismiss"
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
            <div className="raycast-window-chip">
              <span className="raycast-window-text">
                {chatContext.window.app}
                {chatContext.window.title
                  ? ` - ${chatContext.window.title}`
                  : ""}
              </span>
              <button
                type="button"
                className="raycast-screenshot-dismiss"
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
          <input
            className="raycast-input"
            placeholder={
              chatContext?.capturePending
                ? "Capturing screen..."
                : chatContext?.regionScreenshots?.length
                  ? "Ask about the capture..."
                  : chatContext?.window
                    ? "Ask about this window..."
                    : selectedText
                      ? "Ask about the selection..."
                      : "Ask about your screen..."
            }
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && !message && selectedText) {
                setSelectedText(null);
                setChatContext((prev) =>
                  prev ? { ...prev, selectedText: null } : prev,
                );
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
              if (event.key === "Escape") {
                if (previewIndex !== null) {
                  setPreviewIndex(null);
                } else {
                  window.electronAPI?.closeWindow?.();
                }
              }
            }}
            autoFocus
          />
        </div>
        <div className="raycast-actions">
          <button
            className="raycast-action-button"
            type="button"
            onClick={onExpand}
            title="Expand to full view"
          >
            <span className="raycast-action-label">Expand</span>
            <kbd className="raycast-kbd">Tab</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};
