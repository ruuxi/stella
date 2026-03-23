import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";

export type ComposerContextState = {
  hasScreenshotContext: boolean;
  hasFileContext: boolean;
  hasWindowContext: boolean;
  hasWindowTextContext: boolean;
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

export const resolveComposerContextState = (
  chatContext: ChatContext | null,
  selectedText: string | null,
): ComposerContextState => {
  const hasScreenshotContext = Boolean(chatContext?.regionScreenshots?.length);
  const hasFileContext = Boolean(chatContext?.files?.length);
  const hasWindowContext = Boolean(chatContext?.window);
  const hasWindowTextContext = Boolean(chatContext?.windowText?.trim());
  const hasSelectedTextContext = Boolean(selectedText);
  const hasPendingCaptureContext = Boolean(chatContext?.capturePending);
  const hasSubmittableContext = Boolean(
    hasScreenshotContext
      || hasFileContext
      || hasWindowContext
      || hasWindowTextContext
      || hasSelectedTextContext,
  );

  return {
    hasScreenshotContext,
    hasFileContext,
    hasWindowContext,
    hasWindowTextContext,
    hasSelectedTextContext,
    hasPendingCaptureContext,
    hasSubmittableContext,
    hasComposerContext: Boolean(hasSubmittableContext || hasPendingCaptureContext),
  };
};

export const resolveComposerPlaceholder = ({
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
  if (contextState.hasWindowContext || contextState.hasWindowTextContext) {
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
  setChatContext((prev) => (prev ? { ...prev, window: null, windowText: null } : prev));
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
