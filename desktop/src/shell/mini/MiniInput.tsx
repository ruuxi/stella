import { useCallback, useEffect, useRef } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  clearComposerSelectedTextContext,
  deriveComposerState,
} from "@/app/chat/composer-context";
import {
  ComposerCaptureContextSection,
  ComposerFileContextSection,
  ComposerSelectedTextContextSection,
  ComposerWindowContextSection,
} from "@/app/chat/ComposerContextSections";
import {
  ComposerAddButton,
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import { useFileDrop } from "@/app/chat/hooks/use-file-drop";
import { DropOverlay } from "@/app/chat/DropOverlay";

type Props = {
  message: string;
  setMessage: (value: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  previewIndex: number | null;
  setPreviewIndex: (index: number | null) => void;
  isStreaming: boolean;
  shellVisible: boolean;
  onSend: () => void;
  onStop: () => void;
  onAdd?: () => void;
};

export const MiniInput = ({
  message,
  setMessage,
  chatContext,
  setChatContext,
  selectedText,
  setSelectedText,
  previewIndex,
  setPreviewIndex,
  isStreaming,
  shellVisible,
  onSend,
  onStop,
  onAdd,
}: Props) => {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext,
    disabled: isStreaming,
  });

  useEffect(() => {
    if (shellVisible) {
      inputRef.current?.focus();
    }
  }, [shellVisible]);

  const composerState = deriveComposerState({
    message,
    chatContext,
    selectedText,
  });
  const { placeholder, canSubmit } = composerState;

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMessage(e.target.value);
    },
    [setMessage],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Backspace" && !message && selectedText) {
        clearComposerSelectedTextContext(setSelectedText, setChatContext);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canSubmit) {
          onSend();
        }
        return;
      }

      if (e.key === "Escape") {
        if (previewIndex !== null) {
          setPreviewIndex(null);
        } else {
          window.electronAPI?.window.close?.();
        }
      }
    },
    [
      canSubmit,
      message,
      onSend,
      previewIndex,
      selectedText,
      setChatContext,
      setPreviewIndex,
      setSelectedText,
    ],
  );

  return (
    <div className="mini-composer" {...dropHandlers}>
      <DropOverlay visible={isDragOver} variant="mini" />
      <ComposerWindowContextSection
        variant="mini"
        chatContext={chatContext}
        setChatContext={setChatContext}
      />

      <ComposerCaptureContextSection
        variant="mini"
        chatContext={chatContext}
        setChatContext={setChatContext}
        onPreviewScreenshot={setPreviewIndex}
      />

      <ComposerFileContextSection
        variant="mini"
        chatContext={chatContext}
        setChatContext={setChatContext}
      />

      <div className="mini-composer-inner">
        <ComposerSelectedTextContextSection
          variant="mini"
          selectedText={selectedText}
          setSelectedText={setSelectedText}
          setChatContext={setChatContext}
        />

        <ComposerTextarea
          ref={inputRef}
          className="mini-composer-input"
          placeholder={placeholder}
          value={message}
          rows={1}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          autoFocus
        />

        <div className="mini-composer-actions">
          <div className="mini-composer-actions-left">
            <ComposerAddButton
              className="mini-composer-add"
              title="Add"
              onClick={onAdd}
            />
          </div>
          <div className="mini-composer-actions-right">
            {isStreaming && (
              <ComposerStopButton
                className="mini-composer-stop"
                title="Stop"
                aria-label="Stop"
                onClick={onStop}
              />
            )}
            <ComposerSubmitButton
              type="button"
              className="mini-composer-send"
              onClick={onSend}
              disabled={!canSubmit}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
