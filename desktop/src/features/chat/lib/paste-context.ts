/**
 * Composer paste handling: clipboard files (copied screenshots, images,
 * documents) attach through the same pipeline as drag-drop and the "+"
 * picker, and a long pasted text blob lifts out of the textarea into a
 * collapsed "Pasted text" context chip instead of dumping a wall of text
 * into the input. Short pastes fall through to the default inline
 * behavior so quick snippets aren't hidden behind a chip.
 */
import type { ClipboardEvent, Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { attachFilesToContext } from "./file-attach";

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

/** A paste this long (chars) collapses into a chip. */
export const PASTE_AS_CHIP_MIN_CHARS = 1200;
/** ...or this many lines, whichever trips first. */
export const PASTE_AS_CHIP_MIN_LINES = 18;

/**
 * Cap for the hover-preview body stored on / shown by a pasted-text chip.
 * The preview is scrollable (the pointer can move onto it), so this is a
 * generous slice rather than a tooltip-sized one — and it bounds how much
 * pasted text we persist on the sent message's metadata.
 */
export const PASTED_TEXT_PREVIEW_MAX_CHARS = 4000;

export type PastedTextDescriptor = {
  /** Bounded preview slice (≤ `PASTED_TEXT_PREVIEW_MAX_CHARS`) for hovercards. */
  text?: string;
  lines: number;
  chars: number;
};

export const toPastedTextDescriptor = (text: string): PastedTextDescriptor => ({
  text: text.slice(0, PASTED_TEXT_PREVIEW_MAX_CHARS),
  lines: text.split(/\r\n|\r|\n/).length,
  chars: text.length,
});

/** Human label for a pasted-text chip: prefers a line count, falls back to chars. */
export const describePastedText = (descriptor: PastedTextDescriptor): string =>
  descriptor.lines > 1
    ? `${descriptor.lines.toLocaleString()} lines`
    : `${descriptor.chars.toLocaleString()} chars`;

/**
 * Hovercard body for a pasted-text chip: the bounded preview with a
 * trailing ellipsis when the full paste was longer than what we stored.
 * Returns an empty string when no preview text is available (e.g. a chip
 * persisted before previews were stored), so callers can skip the portal.
 */
export const pastedTextPreview = (descriptor: PastedTextDescriptor): string => {
  const text = descriptor.text ?? "";
  if (!text) return "";
  return descriptor.chars > text.length ? `${text}…` : text;
};

export const shouldAttachPastedText = (text: string): boolean => {
  if (!text) return false;
  if (text.length >= PASTE_AS_CHIP_MIN_CHARS) return true;
  return text.split(/\r\n|\r|\n/).length >= PASTE_AS_CHIP_MIN_LINES;
};

export const attachPastedText = (
  text: string,
  setChatContext: SetChatContext,
): void => {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return;
  setChatContext((prev) => {
    const base: ChatContext = prev ?? { window: null };
    return {
      ...base,
      pastedTexts: [...(base.pastedTexts ?? []), trimmed],
    };
  });
};

/**
 * Shared `onPaste` handler for composer textareas. Clipboard files
 * (e.g. a copied screenshot or a file copied in Finder) attach as
 * context chips; a long plain-text blob collapses into a "Pasted text"
 * chip. Returns true when it consumed the event so callers can skip
 * their own paste handling.
 */
export const handleComposerPaste = (
  event: ClipboardEvent<HTMLTextAreaElement>,
  setChatContext: SetChatContext,
): boolean => {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  const files = Array.from(clipboard.files ?? []);
  if (files.length > 0) {
    event.preventDefault();
    void attachFilesToContext(files, setChatContext);
    return true;
  }
  const text = clipboard.getData("text/plain");
  if (!shouldAttachPastedText(text)) return false;
  event.preventDefault();
  attachPastedText(text, setChatContext);
  return true;
};
