import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/types/electron";
import {
  PendingCaptureChip,
  ScreenshotContextChips,
  SelectedTextChip,
  WindowContextChip,
} from "./ComposerContextChips";

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
      {chatContext?.regionScreenshots ? (
        <ScreenshotContextChips
          screenshots={chatContext.regionScreenshots}
          setChatContext={setChatContext}
          chipClassName="composer-context-chip composer-context-chip--screenshot"
          imageClassName="composer-context-thumb"
          removeClassName="composer-context-remove"
        />
      ) : null}

      {chatContext?.capturePending ? (
        <PendingCaptureChip
          className="composer-context-chip composer-context-chip--pending"
          innerClassName="composer-context-pending-inner"
        />
      ) : null}

      {selectedText ? (
        <SelectedTextChip
          selectedText={selectedText}
          setSelectedText={setSelectedText}
          setChatContext={setChatContext}
          className="composer-context-chip composer-context-chip--text"
          textClassName="composer-context-text"
          removeClassName="composer-context-remove"
        />
      ) : null}

      {chatContext?.window ? (
        <WindowContextChip
          chatWindow={chatContext.window}
          setChatContext={setChatContext}
          className="composer-context-chip composer-context-chip--window"
          textClassName="composer-context-window"
          removeClassName="composer-context-remove"
        />
      ) : null}
    </div>
  );
}
