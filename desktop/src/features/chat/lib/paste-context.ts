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

export type PastedTextDescriptor = { lines: number; chars: number };

export const toPastedTextDescriptor = (text: string): PastedTextDescriptor => ({
  lines: text.split(/\r\n|\r|\n/).length,
  chars: text.length,
});

/** Human label for a pasted-text chip: prefers a line count, falls back to chars. */
export const describePastedText = (descriptor: PastedTextDescriptor): string =>
  descriptor.lines > 1
    ? `${descriptor.lines.toLocaleString()} lines`
    : `${descriptor.chars.toLocaleString()} chars`;

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
