/**
 * Copy text to the clipboard, robust against the Async Clipboard API
 * being unavailable or rejected.
 *
 * `navigator.clipboard.writeText` can reject in the Electron renderer
 * when the `clipboard-sanitized-write` permission is denied or the
 * document isn't focused. We fall back to a hidden-textarea +
 * `document.execCommand("copy")`, which works inside the click's user
 * gesture without going through the Async Clipboard permission system.
 *
 * Returns whether the copy succeeded.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy execCommand path.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    const selection = document.getSelection();
    const previousRange =
      selection && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null;
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    // Restore any prior selection so copying doesn't clobber the user's
    // highlight in the chat.
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    return ok;
  } catch {
    return false;
  }
}
