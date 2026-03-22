import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  ComposerCaptureContextSection,
  ComposerFileContextSection,
  ComposerSelectedTextContextSection,
  ComposerWindowContextSection,
} from "./ComposerContextSections";

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
      <ComposerCaptureContextSection
        variant="full"
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
      <ComposerFileContextSection
        variant="full"
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
      <ComposerSelectedTextContextSection
        variant="full"
        selectedText={selectedText}
        setSelectedText={setSelectedText}
        setChatContext={setChatContext}
      />
      <ComposerWindowContextSection
        variant="full"
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
    </div>
  );
}
