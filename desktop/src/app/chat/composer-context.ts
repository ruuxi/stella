import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";

type ComposerContextState = {
  hasScreenshotContext: boolean;
  hasFileContext: boolean;
  hasAppSelectionContext: boolean;
  hasWindowContext: boolean;
  hasVisibleWindowContext: boolean;
  hasSelectedTextContext: boolean;
  hasPendingCaptureContext: boolean;
  hasSubmittableContext: boolean;
  hasComposerContext: boolean;
};

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;
type SetSelectedText = Dispatch<SetStateAction<string | null>>;

type DeriveComposerStateOptions = {
  message: string;
  chatContext?: ChatContext | null;
  selectedText?: string | null;
  conversationId?: string | null;
  requireConversationId?: boolean;
};

type ComposerPlaceholderOptions = {
  contextState: ComposerContextState;
};

/**
 * Hard cap for chip label characters. Window titles, file names, and
 * selected text snippets can run on for dozens of characters and blow out
 * the chip strip width — the chip's button `title` attribute still carries
 * the full text for hover.
 */
const CHIP_LABEL_MAX_CHARS = 12;

export const truncateChipLabel = (
  text: string,
  max: number = CHIP_LABEL_MAX_CHARS,
): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
};

/**
 * Returns true when there is at least one attached chip to render (window,
 * file, screenshot, selected text, or a pending capture). Callers can use
 * this to skip rendering the chip strip container entirely so it doesn't
 * eat layout space when empty.
 */
export const hasAttachedComposerChips = (
  chatContext: ChatContext | null,
  selectedText: string | null,
): boolean => {
  if (selectedText) return true;
  if (!chatContext) return false;
  if (chatContext.window) return true;
  if (chatContext.appSelection) return true;
  if (chatContext.browserUrl) return true;
  if (chatContext.regionScreenshots && chatContext.regionScreenshots.length > 0)
    return true;
  if (chatContext.files && chatContext.files.length > 0) return true;
  if (chatContext.capturePending) return true;
  return false;
};

export const resolveComposerContextState = (
  chatContext: ChatContext | null,
  selectedText: string | null,
): ComposerContextState => {
  const hasVisibleWindowContext = Boolean(chatContext?.window);
  const windowContextEnabled = Boolean(
    chatContext?.window && chatContext.windowContextEnabled !== false,
  );
  const hasScreenshotContext = Boolean(chatContext?.regionScreenshots?.length);
  const hasFileContext = Boolean(chatContext?.files?.length);
  const hasAppSelectionContext = Boolean(chatContext?.appSelection?.snapshot);
  const hasWindowContext = windowContextEnabled;
  const hasSelectedTextContext = Boolean(selectedText);
  const hasPendingCaptureContext = Boolean(chatContext?.capturePending);
  const hasSubmittableContext = Boolean(
    hasScreenshotContext
      || hasFileContext
      || hasAppSelectionContext
      || hasWindowContext
      || hasSelectedTextContext,
  );

  return {
    hasScreenshotContext,
    hasFileContext,
    hasAppSelectionContext,
    hasWindowContext,
    hasVisibleWindowContext,
    hasSelectedTextContext,
    hasPendingCaptureContext,
    hasSubmittableContext,
    hasComposerContext: Boolean(
      hasSubmittableContext || hasPendingCaptureContext || hasVisibleWindowContext,
    ),
  };
};

const resolveComposerPlaceholder = ({
  contextState,
}: ComposerPlaceholderOptions): string => {
  if (contextState.hasPendingCaptureContext) {
    return "Capturing screen...";
  }
  if (contextState.hasScreenshotContext) {
    return "Ask about the capture...";
  }
  if (contextState.hasFileContext) {
    return "Ask about the file...";
  }
  if (contextState.hasAppSelectionContext) {
    return "Ask about the selected area...";
  }
  if (contextState.hasWindowContext) {
    return "Ask about this window...";
  }
  if (contextState.hasSelectedTextContext) {
    return "Ask about the selection...";
  }
  return "Ask anything";
};

export const deriveComposerState = ({
  message,
  chatContext = null,
  selectedText = null,
  conversationId = null,
  requireConversationId = false,
}: DeriveComposerStateOptions) => {
  const contextState = resolveComposerContextState(chatContext, selectedText);
  const trimmedMessage = message.trim();
  const hasMessage = Boolean(trimmedMessage);
  const hasConversation = !requireConversationId || Boolean(conversationId);
  const canSubmit = Boolean(
    hasConversation && (hasMessage || contextState.hasSubmittableContext),
  );

  return {
    contextState,
    placeholder: resolveComposerPlaceholder({ contextState }),
    trimmedMessage,
    hasMessage,
    canSubmit,
  };
};

export const clearComposerWindowContext = (setChatContext: SetChatContext) => {
  setChatContext((prev) => (
    prev ? { ...prev, window: null, windowScreenshot: null, windowContextEnabled: undefined } : prev
  ));
};

export const clearComposerAppSelectionContext = (setChatContext: SetChatContext) => {
  setChatContext((prev) => (
    prev ? { ...prev, appSelection: null } : prev
  ));
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

export const removeComposerFileContext = (
  index: number,
  setChatContext: SetChatContext,
) => {
  setChatContext((prev) => {
    if (!prev) return prev;
    const next = [...(prev.files ?? [])];
    next.splice(index, 1);
    return { ...prev, files: next };
  });
};
