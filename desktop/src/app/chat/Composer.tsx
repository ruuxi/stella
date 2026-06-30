/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */

import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { ComposerContextRow } from "./ComposerContextRow";
import { ComposerLeadRow } from "./ComposerLeadRow";
import { type AssistantReplyPeekProps } from "./AssistantReplyPeek";
import { ComposerAddMenu } from "./ComposerAddMenu";
import {
  ComposerMicButton,
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/features/chat/ComposerPrimitives";
import {
  deriveComposerState,
  hasAttachedComposerChips,
} from "@/features/chat/composer-context";
import { handleComposerPaste } from "@/features/chat/lib/paste-context";
import {
  useScreenshotPreview,
  ScreenshotPreviewOverlay,
} from "./ScreenshotPreview";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
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
  focusRequestId?: number;
  conversationId: string | null;
  onSend: () => void;
  onStop: () => void;
  onNewChat: () => void | Promise<void>;
  onSelectArea?: () => void;
  isDragOver?: boolean;
  replyPeek?: AssistantReplyPeekProps | null;
  suggestionsActive?: boolean;
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
  focusRequestId,
  conversationId,
  onSend,
  onStop,
  onNewChat,
  onSelectArea,
  isDragOver = false,
  replyPeek,
  suggestionsActive = true,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const {
    screenshot: previewScreenshot,
    previewIndex: previewScreenshotIndex,
    setPreviewIndex: setPreviewScreenshotIndex,
  } = useScreenshotPreview(chatContext);

  const onSendRef = useRef(onSend);
  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  const dictation = useDictation({
    message,
    setMessage,
    // Dictation stays available even while the orchestrator is busy
    // (mid-turn / streaming) — the mic is intentionally NOT gated on
    // `isStreaming`. See `submitComposer` for the in-flight submit flow.
    onTranscriptCommitted: () => {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    onCommit: () => {
      onSendRef.current();
    },
  });

  // Submitting while a recording/transcription is still in flight must not
  // race ahead of the dictated text. `commitAndSend` stops + finalizes the
  // recording, waits for the pending transcript to be appended to the
  // composer, and only then fires `onCommit` (→ onSend). For the idle case
  // it sends immediately. Transcription is time-bounded (see the dictation
  // service's per-segment timeout), so a stalled request fails into a
  // recoverable error and fires the commit instead of wedging submit.
  const submitComposer = () => {
    if (dictation.isRecording || dictation.isTranscribing) {
      dictation.commitAndSend();
      return;
    }
    onSend();
  };

  const composerState = deriveComposerState({
    message,
    chatContext,
    selectedText,
    conversationId,
    requireConversationId: true,
  });
  const { placeholder } = composerState;
  // A dictation in flight makes the composer submittable on its own: the
  // pending transcript is the content. Without this the submit arrow stays
  // disabled (canSubmit is false while the text is still empty), so a press
  // during transcription is swallowed and `submitComposer` never runs —
  // the transcription finishes but the message is never sent/queued.
  const dictationInFlight =
    dictation.isRecording || dictation.isTranscribing;
  const canSubmitWithDictation = canSubmit || dictationInFlight;
  const hasText = message.trim().length > 0;
  const dictationBelow = dictation.isRecordingVisible && hasText;
  const dictationInline = dictation.isRecordingVisible && !hasText;
  const isExpanded = composerExpanded || dictationBelow;

  useAnimatedComposerShell({
    shellRef,
    contentRef: shellContentRef,
    formRef,
  });

  useEffect(() => {
    if (!focusRequestId || dictation.isRecording) return;
    const raf = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [dictation.isRecording, focusRequestId]);

  // Keep the pill shape in sync when `message` changes outside of onChange
  // (e.g. cleared by the parent after send, or set by dictation).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      updateComposerTextareaExpansion(textareaRef.current, setComposerExpanded);
    });
    return () => cancelAnimationFrame(raf);
  }, [message]);

  const hasAttachedChips = hasAttachedComposerChips(chatContext, selectedText);

  return (
    <div className="composer">
      <ComposerLeadRow
        replyPeek={replyPeek}
        suggestionsActive={suggestionsActive}
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
      <div
        ref={shellRef}
        className={`composer-shell${isDragOver ? " composer-shell--drag-over" : ""}`}
      >
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
              submitComposer();
            }}
          >
            <ComposerAddMenu
              className="composer-add-button"
              title="Add"
              setChatContext={setChatContext}
              onSelectArea={onSelectArea}
              onNewChat={onNewChat}
            />

            {dictationInline ? (
              <DictationRecordingBar
                levels={dictation.levels}
                elapsedMs={dictation.elapsedMs}
                onCancel={dictation.cancel}
                onConfirm={dictation.toggle}
                onSend={dictation.commitAndSend}
                showControls={dictation.showControls}
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
                      updateComposerTextareaExpansion(
                        textareaRef.current,
                        setComposerExpanded,
                      );
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submitComposer();
                    }
                  }}
                  onPaste={(event) => {
                    handleComposerPaste(event, setChatContext);
                  }}
                  disabled={!conversationId}
                  rows={1}
                />

                <div className="composer-toolbar">
                  <div className="composer-toolbar-left">
                    <ComposerAddMenu
                      className="composer-add-button composer-add-button--toolbar"
                      title="Add"
                      setChatContext={setChatContext}
                      onSelectArea={onSelectArea}
                      onNewChat={onNewChat}
                    />
                  </div>

                  <div className="composer-toolbar-right">
                    <ComposerMicButton
                      className="composer-mic"
                      isTranscribing={dictation.isTranscribing}
                      disabled={dictation.isTranscribing}
                      onClick={dictation.toggle}
                      title={
                        dictation.error
                          ? `Dictation: ${dictation.error}`
                          : undefined
                      }
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
                      disabled={!canSubmitWithDictation}
                      animated
                    />
                  </div>
                </div>

                {dictationBelow && (
                  <div className="composer-dictation-row">
                    <DictationRecordingBar
                      levels={dictation.levels}
                      elapsedMs={dictation.elapsedMs}
                      onCancel={dictation.cancel}
                      onConfirm={dictation.toggle}
                      onSend={dictation.commitAndSend}
                      showControls={dictation.showControls}
                    />
                  </div>
                )}
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
