/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */

import { useRef, useState } from "react";
import type { ChatContext } from "../../types/electron";
import { ComposerContextRow } from "./composer/ComposerContextRow";
import {
  resolveComposerContextState,
  resolveComposerPlaceholder,
} from "./composer/composer-context";

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

  const composerContextState = resolveComposerContextState(
    chatContext,
    selectedText,
  );
  const { hasComposerContext } = composerContextState;

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
          <ComposerContextRow
            chatContext={chatContext}
            selectedText={selectedText}
            setChatContext={setChatContext}
            setSelectedText={setSelectedText}
          />
        )}

        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={resolveComposerPlaceholder({
            chatContext,
            contextState: composerContextState,
          })}
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
