/**
 * BasicComposer — minimal version of the home chat's `Composer`.
 *
 * Built from the same primitives (`ComposerTextarea`, `ComposerSubmitButton`,
 * `ComposerStopButton`) and the same `composer-shell` CSS, so visually it
 * is the home chat composer — same border radius, same focus ring, same
 * fonts, same submit button. The difference is what's *not* there:
 *
 *   - No dictation / mic button (the Store thread doesn't take voice)
 *   - No "+" attach menu (Store has no file attachments)
 *   - No `ChatContext` chip suggestions (those are local-chat-only)
 *   - No screenshot preview overlay
 *
 * Surfaces that need a chat composer without the local-chat features
 * (Store thread, sidebar pinned widgets, future Together panes, etc.)
 * mount this directly. The full `Composer` continues to wrap the home
 * chat surface and remains untouched.
 */
import { useEffect, useRef, type ReactNode } from "react";
import {
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "./ComposerPrimitives";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import "./full-shell.composer.css";

export type BasicComposerProps = {
  message: string;
  setMessage: (next: string) => void;
  onSend: () => void;
  /**
   * Optional cancel handler shown as a Stop button while `isStreaming`
   * is true (mirrors the home chat affordance).
   */
  onStop?: () => void;
  /** Disables submit + textarea while a turn is in flight. */
  isStreaming?: boolean;
  /** Independent gate so callers can require attached chips, etc. */
  canSubmit: boolean;
  placeholder?: string;
  /**
   * Render slot for attached chips (sidebar selections in Store, etc.).
   * Mounted in the same `composer-attached-strip` container the full
   * Composer uses, so the chip styling stays in lockstep.
   */
  attachedChips?: ReactNode;
  focusRequestId?: number;
  /** Override the shell's surface width when needed (e.g. PublishTab). */
  className?: string;
};

export function BasicComposer({
  message,
  setMessage,
  onSend,
  onStop,
  isStreaming = false,
  canSubmit,
  placeholder = "Message",
  attachedChips,
  focusRequestId,
  className,
}: BasicComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef(false);

  useAnimatedComposerShell({ shellRef, contentRef: shellContentRef, formRef });

  useEffect(() => {
    if (!focusRequestId) return;
    const raf = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusRequestId]);

  const hasAttachedChips = Boolean(attachedChips);

  return (
    <div className={`composer${className ? ` ${className}` : ""}`}>
      <div ref={shellRef} className="composer-shell">
        <div ref={shellContentRef} className="composer-shell-content">
          {hasAttachedChips ? (
            <div className="composer-attached-strip">{attachedChips}</div>
          ) : null}

          <form
            ref={formRef}
            className="composer-form"
            aria-busy={isStreaming}
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmit) return;
              onSend();
            }}
          >
            <ComposerTextarea
              ref={textareaRef}
              className="composer-input"
              placeholder={placeholder}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                requestAnimationFrame(() => {
                  updateComposerTextareaExpansion(textareaRef.current, (next) => {
                    expandedRef.current = next;
                  });
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canSubmit) onSend();
                }
              }}
              disabled={isStreaming}
              rows={1}
            />

            <div className="composer-toolbar">
              <div className="composer-toolbar-left" />
              <div className="composer-toolbar-right">
                {isStreaming && onStop ? (
                  <ComposerStopButton
                    className="composer-stop"
                    onClick={onStop}
                    title="Stop"
                    aria-label="Stop"
                  />
                ) : null}
                <ComposerSubmitButton
                  className="composer-submit"
                  disabled={!canSubmit || isStreaming}
                  animated
                />
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
