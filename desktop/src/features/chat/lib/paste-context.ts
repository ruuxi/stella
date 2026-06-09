/**
 * Composer paste handling: lift a long pasted text blob out of the
 * textarea and into a collapsed "Pasted text" context chip instead of
 * dumping a wall of text into the input. Short pastes fall through to the
 * default inline behavior so quick snippets aren't hidden behind a chip.
 */
import type { ClipboardEvent, Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";

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
 * Shared `onPaste` handler for composer textareas. When the clipboard
 * carries a long plain-text blob (and no files), it intercepts the paste
 * and turns it into a context chip. Returns true when it consumed the
 * event so callers can skip their own paste handling.
 */
export const handleComposerPaste = (
  event: ClipboardEvent<HTMLTextAreaElement>,
  setChatContext: SetChatContext,
): boolean => {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  // Files (images, documents) go through the drag-drop / "+" attach
  // pipeline, not here — only intercept pure text pastes.
  if (clipboard.files && clipboard.files.length > 0) return false;
  const text = clipboard.getData("text/plain");
  if (!shouldAttachPastedText(text)) return false;
  event.preventDefault();
  attachPastedText(text, setChatContext);
  return true;
};
