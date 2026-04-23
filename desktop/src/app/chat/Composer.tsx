/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */

import type { Dispatch, SetStateAction } from "react";
import { useRef, useState, useEffect } from "react";
import { animate } from "motion";
import type { ChatContext } from "@/shared/types/electron";
import { ComposerContextRow, ComposerSuggestionContextRow } from "./ComposerContextRow";
import {
  ComposerAddButton,
  ComposerMicButton,
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "./ComposerPrimitives";
import {
  deriveComposerState,
  hasAttachedComposerChips,
} from "./composer-context";
import { useFileDrop } from "./hooks/use-file-drop";
import { DropOverlay } from "./DropOverlay";
import { useScreenshotPreview, ScreenshotPreviewOverlay } from "./ScreenshotPreview";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
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
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const { screenshot: previewScreenshot, previewIndex: previewScreenshotIndex, setPreviewIndex: setPreviewScreenshotIndex } =
    useScreenshotPreview(chatContext);

  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext,
    disabled: isStreaming,
  });

  const dictation = useDictation({
    message,
    setMessage,
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
  const { placeholder } = composerState;
  const isExpanded = composerExpanded;

  /* Shell height animation.
     The shell-content wrapper renders at full natural size (chip strip +
     form). The shell clips overflow and springs its height to match the
     wrapper, creating a smooth reveal animation when chips are added or
     the textarea expands. */
  useEffect(() => {
    const content = shellContentRef.current;
    const form = formRef.current;
    const shell = shellRef.current;
    if (!content || !form || !shell || typeof ResizeObserver === "undefined") return;

    lastHeightRef.current = content.getBoundingClientRect().height;
    shell.style.height = `${lastHeightRef.current}px`;
    // Clamp pill radius to height — a radius equal to the height gives a
    // perfect pill shape but keeps the animation range small (48→20 instead
    // of 999→20) so the shape change is perceptible throughout, not bunched
    // at the tail end. Force a non-pill radius once chips are present so
    // the chip strip never visually overflows the curve.
    const isExpandedNow = form.classList.contains("expanded");
    const hasChipsNow = Boolean(content.querySelector(".composer-attached-strip"));
    shell.style.borderRadius = isExpandedNow || hasChipsNow
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
      const hasChips = Boolean(content.querySelector(".composer-attached-strip"));
      const targetRadius = expanded || hasChips ? 20 : Math.min(999, newH);

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

    ro.observe(content);
    return () => {
      ro.disconnect();
      heightAnimRef.current?.stop();
    };
  }, []);

  const hasAttachedChips = hasAttachedComposerChips(chatContext, selectedText);

  return (
    <div className="composer">
      <ComposerSuggestionContextRow
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
      <div ref={shellRef} className="composer-shell" {...dropHandlers}>
        <DropOverlay visible={isDragOver} variant="full" />
        <div ref={shellContentRef} className="composer-shell-content">
          {hasAttachedChips && (
            <div className="composer-attached-strip">
              <ComposerContextRow
                chatContext={chatContext}
                selectedText={selectedText}
                setChatContext={setChatContext}
                setSelectedText={setSelectedText}
                onPreviewScreenshot={setPreviewScreenshotIndex}
              />
            </div>
          )}
          <form
            ref={formRef}
            className={`composer-form${isExpanded ? " expanded" : ""}`}
            aria-busy={isStreaming}
            onSubmit={(event) => {
              event.preventDefault();
              if (dictation.isRecording) return;
              onSend();
            }}
          >
            <ComposerAddButton
              className="composer-add-button"
              title="Add"
              onClick={onAdd}
            />

            {dictation.isRecording ? (
              <DictationRecordingBar
                levels={dictation.levels}
                elapsedMs={dictation.elapsedMs}
                onCancel={dictation.cancel}
                onConfirm={dictation.toggle}
              />
            ) : (
              <>
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
                    <ComposerMicButton
                      className="composer-mic"
                      isTranscribing={dictation.isTranscribing}
                      disabled={
                        isStreaming || dictation.isTranscribing
                      }
                      onClick={dictation.toggle}
                      title={dictation.error ? `Dictation: ${dictation.error}` : undefined}
                    />
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
              </>
            )}
          </form>
        </div>
      </div>

      {previewScreenshot && previewScreenshotIndex !== null && (
        <ScreenshotPreviewOverlay
          screenshot={previewScreenshot}
          index={previewScreenshotIndex}
          onClose={() => setPreviewScreenshotIndex(null)}
        />
      )}
    </div>
  );
}
