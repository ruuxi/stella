/**
 * Custom audio player used by the media surfaces — a minimal scrubber
 * with play/pause and time readout, replacing the basic native
 * `<audio controls>` element.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "@/ui/icons";

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export const AudioPlayer = ({ src }: { src: string | null }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);

  // Reset transport state when the source swaps so the player can stay
  // mounted across selection changes instead of remounting (which would
  // flash the surface). The <audio> element reloads on src change.
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const remaining = Math.max(0, duration - current);
  const disabled = !src;

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }, []);

  const seekToClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      const audio = audioRef.current;
      if (!track || !audio || duration <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const time = ratio * duration;
      audio.currentTime = time;
      setCurrent(time);
    },
    [duration],
  );

  return (
    <div className={`audio-player${disabled ? " audio-player--loading" : ""}`}>
      <audio
        ref={audioRef}
        {...(src ? { src } : {})}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
      />
      <button
        type="button"
        className="audio-player__play"
        onClick={toggle}
        disabled={disabled}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <Pause size={17} strokeWidth={0} fill="currentColor" />
        ) : (
          <Play size={17} strokeWidth={0} fill="currentColor" />
        )}
      </button>
      <div className="audio-player__main">
        <div
          className={`audio-player__scrub${
            scrubbing ? " audio-player__scrub--scrubbing" : ""
          }`}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setScrubbing(true);
            seekToClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (scrubbing) seekToClientX(e.clientX);
          }}
          onPointerUp={(e) => {
            setScrubbing(false);
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              // pointer already released
            }
          }}
          onKeyDown={(e) => {
            const audio = audioRef.current;
            if (!audio || duration <= 0) return;
            if (e.key === "ArrowRight") {
              audio.currentTime = Math.min(duration, audio.currentTime + 5);
            } else if (e.key === "ArrowLeft") {
              audio.currentTime = Math.max(0, audio.currentTime - 5);
            } else if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <div className="audio-player__track" ref={trackRef}>
            <div
              className="audio-player__fill"
              style={{ width: `${progress * 100}%` }}
            />
            <div
              className="audio-player__knob"
              style={{ left: `${progress * 100}%` }}
            />
          </div>
        </div>
        <div className="audio-player__time">
          <span>{formatTime(current)}</span>
          <span>-{formatTime(remaining)}</span>
        </div>
      </div>
    </div>
  );
};
