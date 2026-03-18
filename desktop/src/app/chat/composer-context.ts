import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";

export type ComposerContextState = {
  hasScreenshotContext: boolean;
  hasWindowContext: boolean;
  hasSelectedTextContext: boolean;
  hasComposerContext: boolean;
};

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;
type SetSelectedText = Dispatch<SetStateAction<string | null>>;

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

export const clearComposerWindowContext = (setChatContext: SetChatContext) => {
  setChatContext((prev) => (prev ? { ...prev, window: null } : prev));
};

export const clearComposerSelectedTextContext = (
  setSelectedText: SetSelectedText,
  setChatContext: SetChatContext,
) => {
  setSelectedText(null);
  setChatContext((prev) => (prev ? { ...prev, selectedText: null } : prev));
};

export const removeComposerScreenshotContext = (
  index: number,
  setChatContext: SetChatContext,
) => {
  window.electronAPI?.capture.removeScreenshot?.(index);
  setChatContext((prev) => {
    if (!prev) return prev;
    const next = [...(prev.regionScreenshots ?? [])];
    next.splice(index, 1);
    return { ...prev, regionScreenshots: next };
  });
};


