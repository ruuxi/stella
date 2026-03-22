/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */

import type { Dispatch, SetStateAction } from "react";
import { useRef, useState, useEffect } from "react";
import { animate } from "motion";
import type { ChatContext } from "@/shared/types/electron";
import { ComposerContextRow } from "./ComposerContextRow";
import {
  ComposerAddButton,
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "./ComposerPrimitives";
import {
  deriveComposerState,
} from "./composer-context";
import { useFileDrop } from "./hooks/use-file-drop";
import { DropOverlay } from "./DropOverlay";
import "./full-shell.composer.css";

type ComposerProps = {
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  isStreaming: boolean;
  canSubmit: boolean;
  conversationId: string | null;
  onSend: () => void;
  onStop: () => void;
  onAdd?: () => void;
};

export function Composer({
  message,
  setMessage,
  chatContext,
  setChatContext,
  selectedText,
  setSelectedText,
  isStreaming,
  canSubmit,
  conversationId,
  onSend,
  onStop,
  onAdd,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);

  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext,
    disabled: isStreaming,
  });

  const heightAnimRef = useRef<ReturnType<typeof animate> | null>(null);
  const lastHeightRef = useRef(0);

  const composerState = deriveComposerState({
    message,
    chatContext,
    selectedText,
    conversationId,
    requireConversationId: true,
  });
  const { contextState: composerContextState, placeholder } = composerState;
  const { hasComposerContext } = composerContextState;
  const isExpanded = composerExpanded;

  /* Shell/inner height animation.
     The form renders at full natural size (no constraints on children).
     The shell clips overflow and springs its height to match the form,
     creating a smooth reveal animation. */
  useEffect(() => {
    const form = formRef.current;
    const shell = shellRef.current;
    if (!form || !shell || typeof ResizeObserver === "undefined") return;

    lastHeightRef.current = form.getBoundingClientRect().height;
    shell.style.height = `${lastHeightRef.current}px`;
    // Clamp pill radius to element height — a radius equal to the height
    // gives a perfect pill shape but keeps the animation range small
    // (48→20 instead of 999→20) so the shape change is perceptible
    // throughout, not bunched at the tail end.
    shell.style.borderRadius = form.classList.contains("expanded")
      ? "20px"
      : `${Math.min(999, lastHeightRef.current)}px`;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const newH =
        entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (Math.abs(newH - lastHeightRef.current) < 1) return;

      lastHeightRef.current = newH;
      const expanded = form.classList.contains("expanded");
      const targetRadius = expanded ? 20 : Math.min(999, newH);

      heightAnimRef.current?.stop();
      heightAnimRef.current = animate(
        shell,
        { height: `${newH}px`, borderRadius: `${targetRadius}px` },
        {
          type: "spring",
          duration: 0.35,
          bounce: 0,
        },
      );
    });

    ro.observe(form);
    return () => {
      ro.disconnect();
      heightAnimRef.current?.stop();
    };
  }, []);

  return (
    <div className="composer">
      {hasComposerContext && (
        <div className="composer-floating-context">
          <ComposerContextRow
            chatContext={chatContext}
            selectedText={selectedText}
            setChatContext={setChatContext}
            setSelectedText={setSelectedText}
          />
        </div>
      )}

      <div ref={shellRef} className="composer-shell" {...dropHandlers}>
        <DropOverlay visible={isDragOver} variant="full" />
        <form
          ref={formRef}
          className={`composer-form${isExpanded ? " expanded" : ""}`}
          aria-busy={isStreaming}
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <ComposerAddButton
            className="composer-add-button"
            title="Add"
            onClick={onAdd}
          />

          <ComposerTextarea
            ref={textareaRef}
            className="composer-input"
            placeholder={placeholder}
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
              <ComposerAddButton
                className="composer-add-button composer-add-button--toolbar"
                title="Add"
                onClick={onAdd}
              />
            </div>

            <div className="composer-toolbar-right">
              {isStreaming && (
                <ComposerStopButton
                  className="composer-stop"
                  onClick={onStop}
                  title="Stop"
                  aria-label="Stop"
                />
              )}
              <ComposerSubmitButton
                className="composer-submit"
                disabled={!canSubmit}
                animated
              />
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
