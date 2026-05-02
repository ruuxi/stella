/**
 * DictationRecordingBar — replaces the composer's textarea + toolbar while
 * dictation is active. Lays out as flex children of the surrounding form so
 * the existing pill shell wraps it without any extra height contortions:
 *
 *   [waveform — flex 1]   [0:24]   [X]   [✓]   [↑ (optional)]
 *
 * The optional send arrow is only wired by the in-app composers — the
 * global overlay (used to dictate into other apps) omits it.
 *
 * The waveform is drawn to a single <canvas> so we can repaint at the level
 * tick rate (~12 Hz) without re-rendering hundreds of DOM nodes.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import "./dictation-recording-bar.css";

type DictationRecordingBarProps = {
  levels: number[];
  elapsedMs: number;
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * When provided, renders an arrow button to the right of the check that
   * stops dictation and immediately submits the resulting message. Only the
   * in-app composers pass this; the global overlay omits it because the
   * transcript is being pasted into another application.
   */
  onSend?: () => void;
};

export function DictationRecordingBar({
  levels,
  elapsedMs,
  onCancel,
  onConfirm,
  onSend,
}: DictationRecordingBarProps) {
  return (
    <>
      <DictationWaveform levels={levels} />
      <span className="composer-dictation-timer" aria-live="polite">
        {formatElapsed(elapsedMs)}
      </span>
      <button
        type="button"
        className={cn("chat-composer-icon-button composer-dictation-control")}
        onClick={onCancel}
        title="Cancel dictation"
        aria-label="Cancel dictation"
      >
        <CancelIcon />
      </button>
      <button
        type="button"
        className={cn(
          "chat-composer-icon-button composer-dictation-control",
          "composer-dictation-control--confirm",
        )}
        onClick={onConfirm}
        title="Stop and transcribe"
        aria-label="Stop dictation and transcribe"
      >
        <CheckIcon />
      </button>
      {onSend && (
        <button
          type="button"
          className={cn(
            "chat-composer-icon-button composer-dictation-control",
            "composer-dictation-control--send",
          )}
          onClick={onSend}
          title="Stop, transcribe, and send"
          aria-label="Stop dictation, transcribe, and send"
        >
          <SendIcon />
        </button>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Waveform canvas                                                            */
/* -------------------------------------------------------------------------- */

const BAR_WIDTH_CSS = 2;
const BAR_GAP_CSS = 1;
const MIN_BAR_HEIGHT_CSS = 1;

function DictationWaveform({ levels }: { levels: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Cache the resolved bar color so we don't re-read computed style on every
  // tick. Falling back to text-weak inside the effect.
  const barColorRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    if (!barColorRef.current) {
      const cs = getComputedStyle(canvas);
      const resolved =
        cs.getPropertyValue("color").trim() ||
        cs.getPropertyValue("--text-weak").trim() ||
        "#9aa1a8";
      barColorRef.current = resolved;
    }

    ctx.clearRect(0, 0, targetW, targetH);

    const barCount = levels.length;
    if (barCount === 0) return;

    const barW = BAR_WIDTH_CSS * dpr;
    const gap = BAR_GAP_CSS * dpr;
    const stride = barW + gap;
    const maxVisible = Math.max(1, Math.floor(targetW / stride));
    const visibleCount = Math.min(barCount, maxVisible);
    const startIndex = barCount - visibleCount;

    const midY = targetH / 2;
    const minBarH = MIN_BAR_HEIGHT_CSS * dpr;
    const maxBarH = targetH;

    ctx.fillStyle = barColorRef.current;
    // Right-align the bar series so the most recent sample sits on the right
    // edge of the canvas; older bars scroll off the left as the buffer fills.
    const startX = targetW - visibleCount * stride + gap / 2;

    for (let i = 0; i < visibleCount; i += 1) {
      const level = levels[startIndex + i]!;
      const barH = Math.max(
        minBarH,
        Math.min(maxBarH, level * maxBarH),
      );
      const x = startX + i * stride;
      const y = midY - barH / 2;
      ctx.fillRect(x, y, barW, barH);
    }
  }, [levels]);

  return (
    <canvas
      ref={canvasRef}
      className="composer-dictation-waveform"
      aria-hidden
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const formatElapsed = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

function CancelIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="5 12 10 17 19 7" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
