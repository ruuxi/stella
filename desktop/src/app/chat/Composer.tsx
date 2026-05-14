/**
 * Composer: Input bar, attachment handling, send/stream logic, stop button, context chips.
 */

import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { ComposerContextRow, ComposerSuggestionContextRow } from "./ComposerContextRow";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { ComposerAreaSelectOverlay } from "./ComposerAreaSelectOverlay";
import {
  ComposerMicButton,
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "./ComposerPrimitives";
import {
  deriveComposerState,
  hasAttachedComposerChips,
} from "./composer-context";
import { useScreenshotPreview, ScreenshotPreviewOverlay } from "./ScreenshotPreview";
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
  indicator?: InlineWorkingIndicatorMountProps;
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
  indicator,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [areaSelectActive, setAreaSelectActive] = useState(false);
  const { screenshot: previewScreenshot, previewIndex: previewScreenshotIndex, setPreviewIndex: setPreviewScreenshotIndex } =
    useScreenshotPreview(chatContext);

  const onSendRef = useRef(onSend);
  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  const dictation = useDictation({
    message,
    setMessage,
    disabled: isStreaming,
    onTranscriptCommitted: () => {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    onCommit: () => {
      onSendRef.current();
    },
  });

  const composerState = deriveComposerState({
    message,
    chatContext,
    selectedText,
    conversationId,
    requireConversationId: true,
  });
  const { placeholder } = composerState;
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
      updateComposerTextareaExpansion(
        textareaRef.current,
        setComposerExpanded,
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [message]);

  const hasAttachedChips = hasAttachedComposerChips(chatContext, selectedText);

  return (
    <div className="composer">
      <ComposerSuggestionContextRow
        chatContext={chatContext}
        setChatContext={setChatContext}
        indicator={indicator}
      />
      <div ref={shellRef} className="composer-shell">
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
            <ComposerAddMenu
              className="composer-add-button"
              title="Add"
              setChatContext={setChatContext}
              onSelectArea={() => setAreaSelectActive(true)}
              disabled={isStreaming}
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
                      onSend();
                    }
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
                      onSelectArea={() => setAreaSelectActive(true)}
                      disabled={isStreaming}
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
      <ComposerAreaSelectOverlay
        active={areaSelectActive}
        setChatContext={setChatContext}
        onCancel={() => setAreaSelectActive(false)}
      />
    </div>
  );
}
