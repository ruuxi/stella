import { Play, Pause, Square } from "lucide-react"
import { DashboardCard } from "./DashboardCard"
import { useLyriaMusic } from "@/services/use-lyria-music"
import type { MusicMood } from "@/services/lyria-music"

const MOODS: MusicMood[] = ["Focus", "Calm", "Energy", "Sleep", "Lo-fi"]

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

export function MusicPlayer() {
  const {
    status,
    mood,
    error,
    currentPromptLabel,
    elapsedSeconds,
    togglePlayPause,
    selectMood,
    stop,
  } = useLyriaMusic()

  const isActive = status === "playing" || status === "paused" || status === "loading"

  return (
    <DashboardCard
      label="Ambient"
      actions={
        isActive ? (
          <button className="music-stop-btn" onClick={stop} aria-label="Stop">
            <Square size={10} />
          </button>
        ) : undefined
      }
    >
      <div className="music-player-row">
        <button
          className={`music-play-btn${isActive ? " music-play-btn--active" : ""}`}
          onClick={togglePlayPause}
          disabled={status === "loading"}
          aria-label={status === "playing" ? "Pause" : "Play"}
        >
          {status === "loading" ? (
            <span className="music-loading-dot" />
          ) : status === "playing" ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
        </button>
        <div className="music-track-info">
          <span className="music-track-title">
            {error
              ? "Unable to play"
              : status === "loading"
                ? "Starting..."
                : isActive
                  ? currentPromptLabel || mood
                  : "Tap play to start"}
          </span>
        </div>
        <span className="music-track-duration">
          {isActive ? formatTime(elapsedSeconds) : ""}
        </span>
      </div>
      <div className="music-moods">
        {MOODS.map((m) => (
          <button
            key={m}
            className={`music-mood-chip${m === mood ? " music-mood-chip--selected" : ""}`}
            onClick={() => selectMood(m)}
          >
            {m}
          </button>
        ))}
      </div>
    </DashboardCard>
  )
}
