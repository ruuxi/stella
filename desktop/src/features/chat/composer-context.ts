import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";

type ComposerContextState = {
  hasScreenshotContext: boolean;
  hasFileContext: boolean;
  hasPastedTextContext: boolean;
  hasAppSelectionContext: boolean;
  hasActivityContext: boolean;
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
 * Selected-area chips accumulate like attachments. The cap bounds both
 * the chip strip and the prompt payload (each selection carries a text
 * snapshot + anchor metadata); appending past it drops the oldest.
 */
export const MAX_APP_SELECTIONS = 8;

type ComposerAppSelection = NonNullable<ChatContext["appSelection"]>;

/**
 * All selected-area contexts, newest last. Reads the `appSelections`
 * list; falls back to the legacy single `appSelection` slot for contexts
 * produced before selections became appendable.
 */
export const getComposerAppSelections = (
  chatContext: ChatContext | null,
): ComposerAppSelection[] => {
  const list = chatContext?.appSelections;
  if (list && list.length > 0) return list;
  return chatContext?.appSelection ? [chatContext.appSelection] : [];
};

// Identity for dedupe: re-selecting the same area (same label, content
// snapshot, bounds, and anchoring) must not grow a second chip.
const appSelectionDedupeKey = (selection: ComposerAppSelection): string =>
  JSON.stringify([
    selection.label,
    selection.snapshot,
    selection.bounds,
    selection.surface ?? null,
    selection.anchor?.path ?? null,
    selection.source?.filePath ?? null,
    selection.source?.lineNumber ?? null,
  ]);

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
  if (chatContext.activity) return true;
  if (chatContext.window) return true;
  if (getComposerAppSelections(chatContext).length > 0) return true;
  if (chatContext.browserUrl) return true;
  if (chatContext.regionScreenshots && chatContext.regionScreenshots.length > 0)
    return true;
  if (chatContext.files && chatContext.files.length > 0) return true;
  if (chatContext.pastedTexts && chatContext.pastedTexts.length > 0) return true;
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
  const hasPastedTextContext = Boolean(chatContext?.pastedTexts?.length);
  const hasAppSelectionContext = getComposerAppSelections(chatContext).some(
    (selection) => Boolean(selection.snapshot),
  );
  const hasActivityContext = Boolean(chatContext?.activity?.id);
  const hasWindowContext = windowContextEnabled;
  const hasSelectedTextContext = Boolean(selectedText);
  const hasPendingCaptureContext = Boolean(chatContext?.capturePending);
  const hasSubmittableContext = Boolean(
    hasScreenshotContext
      || hasFileContext
      || hasPastedTextContext
      || hasAppSelectionContext
      || hasActivityContext
      || hasWindowContext
      || hasSelectedTextContext,
  );

  return {
    hasScreenshotContext,
    hasFileContext,
    hasPastedTextContext,
    hasAppSelectionContext,
    hasActivityContext,
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
  if (contextState.hasPastedTextContext) {
    return "Ask about the pasted text...";
  }
  if (contextState.hasAppSelectionContext) {
    return "Ask about the selected area...";
  }
  if (contextState.hasActivityContext) {
    return "Ask about this activity...";
  }
  if (contextState.hasWindowContext) {
    return "Ask about this window...";
  }
  if (contextState.hasSelectedTextContext) {
    return "Ask about the selection...";
  }
  return "Do anything";
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
    prev
      ? {
          ...prev,
          window: null,
          browserUrl: null,
          windowScreenshot: null,
          windowAxTree: null,
          capturePending: false,
          windowContextEnabled: undefined,
        }
      : prev
  ));
};

export const clearComposerAppSelectionContext = (setChatContext: SetChatContext) => {
  setChatContext((prev) => (
    prev ? { ...prev, appSelection: null, appSelections: [] } : prev
  ));
};

/**
 * Appends a selected-area context chip. Selections accumulate like
 * attachments (dedupe on identical re-selects, capped at
 * `MAX_APP_SELECTIONS`); the legacy `appSelection` slot mirrors the
 * newest entry for single-slot readers.
 */
export const attachComposerAppSelectionContext = (
  selection: ComposerAppSelection,
  setChatContext: SetChatContext,
) => {
  setChatContext((prev) => {
    const base = prev ?? {
      window: null,
      browserUrl: null,
      selectedText: null,
      regionScreenshots: [],
    };
    const existing = getComposerAppSelections(prev);
    const key = appSelectionDedupeKey(selection);
    if (existing.some((entry) => appSelectionDedupeKey(entry) === key)) {
      // Identical area re-selected — keep the existing chip (but make
      // sure a legacy single-slot context is normalized onto the list).
      return prev?.appSelections?.length
        ? prev
        : {
            ...base,
            appSelections: existing,
            appSelection: existing[existing.length - 1] ?? null,
          };
    }
    const appSelections = [...existing, selection].slice(-MAX_APP_SELECTIONS);
    return {
      ...base,
      appSelections,
      appSelection: appSelections[appSelections.length - 1] ?? null,
    };
  });
};

/** Removes one selected-area chip; the mirror slot tracks the newest left. */
export const removeComposerAppSelectionContext = (
  index: number,
  setChatContext: SetChatContext,
) => {
  setChatContext((prev) => {
    if (!prev) return prev;
    const existing = getComposerAppSelections(prev);
    if (index < 0 || index >= existing.length) return prev;
    const appSelections = existing.filter((_, i) => i !== index);
    return {
      ...prev,
      appSelections,
      appSelection: appSelections[appSelections.length - 1] ?? null,
    };
  });
};

export const clearComposerActivityContext = (setChatContext: SetChatContext) => {
  setChatContext((prev) => (
    prev ? { ...prev, activity: null } : prev
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

export const removeComposerPastedTextContext = (
  index: number,
  setChatContext: SetChatContext,
) => {
  setChatContext((prev) => {
    if (!prev) return prev;
    const next = [...(prev.pastedTexts ?? [])];
    next.splice(index, 1);
    return { ...prev, pastedTexts: next };
  });
};
