/**
 * Per-message action row rendered below a chat message.
 *
 * - User messages get a single Copy action.
 * - Assistant messages get Copy + Read aloud (on-demand TTS).
 *
 * The row reserves its height at all times and only fades in on row hover /
 * keyboard focus (or while its read-aloud is active) so revealing it never
 * shifts surrounding row geometry, which the chat's scroll-follow logic
 * depends on.
 *
 * It is mounted *throughout* an assistant message's lifetime — including
 * while it is still streaming — so its reserved height is present from the
 * first painted line and finalizing the message causes NO layout jump. While
 * `streaming` is true the row is held invisible and made `inert` (not
 * focusable, not clickable, hidden from the accessibility tree); it cannot
 * reveal on hover/focus until the message settles. The CSS that suppresses
 * the reveal keys off the row's `.event-row--streaming` ancestor (see
 * `message-actions.css`).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, Square, Volume2 } from "@/ui/icons";
import {
  toggleManualReadAloud,
  useManualReadAloudStatus,
} from "@/features/voice/services/read-aloud/manual-read-aloud";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import "./message-actions.css";

type MessageActionsProps = {
  /** Raw text to copy / read aloud. */
  text: string;
  /** Stable key identifying this message (drives read-aloud playback state). */
  messageKey: string;
  /** Show the read-aloud (volume) button. Assistant rows only. */
  showReadAloud?: boolean;
  /** Row alignment — `end` right-aligns under the user bubble. */
  align?: "start" | "end";
  /**
   * True while the owning message is still streaming. The row stays mounted
   * (reserving its height) but is held invisible + `inert` so it can't be
   * focused, clicked, or read by assistive tech, and never reveals on hover
   * until the message finalizes.
   */
  streaming?: boolean;
};

const COPIED_RESET_MS = 1600;

function MessageActionsImpl({
  text,
  messageKey,
  showReadAloud = false,
  align = "start",
  streaming = false,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readAloudStatus = useManualReadAloudStatus(messageKey);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const value = text.trim();
    if (!value) return;
    const ok = await copyTextToClipboard(value);
    if (!ok) {
      console.warn("[message-actions] copy failed");
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [text]);

  const handleReadAloud = useCallback(() => {
    void toggleManualReadAloud(messageKey, text);
  }, [messageKey, text]);

  const isPlaying = readAloudStatus !== "idle";

  return (
    <div
      className={`message-actions message-actions--${align}`}
      data-active={isPlaying ? "true" : undefined}
      data-streaming={streaming ? "true" : undefined}
      // `inert` keeps the still-streaming (invisible) row out of the tab
      // order and the accessibility tree and blocks pointer interaction —
      // belt-and-suspenders with the CSS that holds it at opacity:0.
      inert={streaming || undefined}
    >
      <button
        type="button"
        className="message-actions__btn"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? (
          <Check size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Copy size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      {showReadAloud && (
        <button
          type="button"
          className="message-actions__btn"
          onClick={handleReadAloud}
          aria-label={isPlaying ? "Stop reading" : "Read aloud"}
          title={isPlaying ? "Stop reading" : "Read aloud"}
          aria-pressed={isPlaying}
        >
          {readAloudStatus === "loading" ? (
            <LoaderCircle
              className="message-actions__spinner"
              size={14}
              strokeWidth={2}
              aria-hidden="true"
            />
          ) : readAloudStatus === "playing" ? (
            <Square
              size={12}
              strokeWidth={2}
              fill="currentColor"
              aria-hidden="true"
            />
          ) : (
            <Volume2 size={14} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

export const MessageActions = memo(MessageActionsImpl);
