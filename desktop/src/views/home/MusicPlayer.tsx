import { Play } from "lucide-react"
import { DashboardCard } from "./DashboardCard"

const MOODS = ["Focus", "Calm", "Energy", "Sleep", "Lo-fi"] as const

export function MusicPlayer() {
  return (
    <DashboardCard label="Ambient">
      <div className="music-player-row">
        <button className="music-play-btn" disabled aria-label="Play">
          <Play size={14} />
        </button>
        <div className="music-track-info">
          <span className="music-track-title">No track selected</span>
        </div>
        <span className="music-track-duration">0:00</span>
      </div>
      <div className="music-moods">
        {MOODS.map((mood) => (
          <button key={mood} className="music-mood-chip" disabled>
            {mood}
          </button>
        ))}
      </div>
    </DashboardCard>
  )
}
