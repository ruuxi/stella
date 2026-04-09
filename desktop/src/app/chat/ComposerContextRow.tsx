import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { ChatSuggestions } from "./ChatSuggestions";
import {
  ComposerCaptureContextSection,
  ComposerFileContextSection,
  ComposerSelectedTextContextSection,
  ComposerWindowContextSection,
} from "./ComposerContextSections";

type ComposerContextRowProps = {
  variant?: "full" | "mini";
  chatContext: ChatContext | null;
  selectedText: string | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
  onPreviewScreenshot?: (index: number) => void;
  onSuggestionSelect?: (prompt: string) => void;
};

export function ComposerContextRow({
  variant = "full",
  chatContext,
  selectedText,
  setChatContext,
  setSelectedText,
  onPreviewScreenshot,
  onSuggestionSelect,
}: ComposerContextRowProps) {
  return (
    <div className="composer-context-actions">
      {onSuggestionSelect ? (
        <ChatSuggestions
          variant={variant}
          onSelect={onSuggestionSelect}
        />
      ) : null}
      <ComposerCaptureContextSection
        variant={variant}
        chatContext={chatContext}
        setChatContext={setChatContext}
        onPreviewScreenshot={onPreviewScreenshot}
      />
      <ComposerFileContextSection
        variant={variant}
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
      <ComposerSelectedTextContextSection
        variant={variant}
        selectedText={selectedText}
        setSelectedText={setSelectedText}
        setChatContext={setChatContext}
      />
      <ComposerWindowContextSection
        variant={variant}
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
    </div>
  );
}
