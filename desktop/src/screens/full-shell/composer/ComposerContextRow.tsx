import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "../../../types/electron";

type ComposerContextRowProps = {
  chatContext: ChatContext | null;
  selectedText: string | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
};

export function ComposerContextRow({
  chatContext,
  selectedText,
  setChatContext,
  setSelectedText,
}: ComposerContextRowProps) {
  return (
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
          <span className="composer-context-text">&quot;{selectedText}&quot;</span>
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
            {chatContext.window.title ? ` - ${chatContext.window.title}` : ""}
          </span>
          <button
            type="button"
            className="composer-context-remove"
            aria-label="Remove window context"
            onClick={(event) => {
              event.stopPropagation();
              setChatContext((prev) => (prev ? { ...prev, window: null } : prev));
            }}
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}

