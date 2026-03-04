import type { ChatContext } from "../../../types/electron";

export type ComposerContextState = {
  hasScreenshotContext: boolean;
  hasWindowContext: boolean;
  hasSelectedTextContext: boolean;
  hasComposerContext: boolean;
};

type ComposerPlaceholderOptions = {
  chatContext: ChatContext | null;
  contextState: ComposerContextState;
};

export const resolveComposerContextState = (
  chatContext: ChatContext | null,
  selectedText: string | null,
): ComposerContextState => {
  const hasScreenshotContext = Boolean(chatContext?.regionScreenshots?.length);
  const hasWindowContext = Boolean(chatContext?.window);
  const hasSelectedTextContext = Boolean(selectedText);

  return {
    hasScreenshotContext,
    hasWindowContext,
    hasSelectedTextContext,
    hasComposerContext: Boolean(
      hasScreenshotContext ||
        hasWindowContext ||
        hasSelectedTextContext ||
        chatContext?.capturePending,
    ),
  };
};

export const resolveComposerPlaceholder = ({
  chatContext,
  contextState,
}: ComposerPlaceholderOptions): string => {
  if (chatContext?.capturePending) {
    return "Capturing screen...";
  }
  if (contextState.hasScreenshotContext) {
    return "Ask about the capture...";
  }
  if (contextState.hasWindowContext) {
    return "Ask about this window...";
  }
  if (contextState.hasSelectedTextContext) {
    return "Ask about the selection...";
  }
  return "Ask anything";
};

