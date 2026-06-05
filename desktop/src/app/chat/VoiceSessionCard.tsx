/**
 * Inline summary pill for a finished realtime voice session. Replaces the
 * raw "Voice session — Duration: …" text body on the visible assistant
 * message that the voice session manager writes when it deactivates
 * (see `endVisibleVoiceSession` in `use-realtime-voice.ts`).
 *
 * Reads the structured `voiceSession` metadata off the assistant message
 * rather than parsing the text, so the surface stays robust if the
 * fallback wording changes.
 */
import { AudioLines } from "lucide-react";
import "./voice-session-card.css";

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
};

export function VoiceSessionCard({ durationMs }: { durationMs: number }) {
  return (
    <span className="voice-session-pill">
      <AudioLines
        className="voice-session-pill__icon"
        size={13}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="voice-session-pill__label">Talked with Stella</span>
      <span className="voice-session-pill__meta">
        {formatDuration(durationMs)}
      </span>
    </span>
  );
}
