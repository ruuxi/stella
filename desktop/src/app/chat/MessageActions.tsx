/**
 * Per-message action row rendered below a settled chat message.
 *
 * - User messages get a single Copy action.
 * - Assistant messages get Copy + Read aloud (on-demand TTS).
 *
 * Never mounted while a message is still streaming — the caller gates on
 * the finalized state. The row reserves its height at all times and only
 * fades in on row hover / keyboard focus (or while its read-aloud is
 * active) so revealing it never shifts surrounding row geometry, which
 * the chat's scroll-follow logic depends on.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, Square, Volume2 } from "lucide-react";
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
};

const COPIED_RESET_MS = 1600;

function MessageActionsImpl({
  text,
  messageKey,
  showReadAloud = false,
  align = "start",
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
