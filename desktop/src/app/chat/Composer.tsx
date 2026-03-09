/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */

import { useRef, useState, useEffect } from "react";
import { animate } from "motion";
import { motion } from "motion/react";
import type { ChatContext } from "@/types/electron";
import { ComposerContextRow } from "./ComposerContextRow";
import {
  resolveComposerContextState,
  resolveComposerPlaceholder,
} from "./composer-context";
import "./full-shell.composer.css";

type ComposerProps = {
  message: string;
  setMessage: (message: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  isStreaming: boolean;
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
  canSubmit,
  conversationId,
  onSend,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);

  const heightAnimRef = useRef<ReturnType<typeof animate> | null>(null);
  const lastHeightRef = useRef(0);

  const composerContextState = resolveComposerContextState(
    chatContext,
    selectedText,
  );
  const { hasComposerContext } = composerContextState;
  const isExpanded = composerExpanded || hasComposerContext;

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
      <div ref={shellRef} className="composer-shell">
        <form
          ref={formRef}
          className={`composer-form${isExpanded ? " expanded" : ""}`}
          aria-busy={isStreaming}
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
            </div>

            <div className="composer-toolbar-right">
              <motion.button
                type="submit"
                className="composer-submit"
                disabled={!canSubmit}
                animate={{
                  opacity: canSubmit ? 1 : 0.4,
                  scale: canSubmit ? 1 : 0.92,
                  filter: canSubmit ? "blur(0px)" : "blur(0.5px)",
                }}
                whileHover={canSubmit ? { opacity: 0.9 } : {}}
                transition={{ type: "spring", duration: 0.2, bounce: 0 }}
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
              </motion.button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
