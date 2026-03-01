import { Play, Pause, Square, Mic, MicOff } from "lucide-react"
import { useRef, useEffect, useState, useCallback } from "react"
import { DashboardCard } from "./DashboardCard"
import { preloadLyriaMusic, useLyriaMusic } from "@/services/use-lyria-music"
import type { MusicMood } from "@/services/lyria-music"

const MOODS: MusicMood[] = ["Auto", "Focus", "Calm", "Energy", "Sleep", "Lo-fi"]

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

// ---------------------------------------------------------------------------
// Waveform canvas
// ---------------------------------------------------------------------------

function Waveform({ analyserRef }: { analyserRef: React.RefObject<AnalyserNode | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const frameCountRef = useRef(0)
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const colorRef = useRef("rgba(255,255,255,0.5)")
  const dimensionsRef = useRef({ width: 0, height: 0, dpr: 1 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const updateDimensions = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))

      dimensionsRef.current = { width, height, dpr }
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
    }

    updateDimensions()

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updateDimensions()
          })

    resizeObserver?.observe(canvas)

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)

      const analyser = analyserRef.current
      const { width, height, dpr } = dimensionsRef.current
      if (!analyser) {
        ctx.clearRect(0, 0, width, height)
        return
      }

      const bufferLength = analyser.frequencyBinCount
      let dataArray = dataArrayRef.current
      if (!dataArray || dataArray.length !== bufferLength) {
        dataArray = new Uint8Array(new ArrayBuffer(bufferLength))
        dataArrayRef.current = dataArray
      }
      analyser.getByteFrequencyData(dataArray)

      // Refresh computed styles occasionally to avoid per-frame style recalc.
      if (frameCountRef.current % 30 === 0) {
        colorRef.current = getComputedStyle(canvas).color || "rgba(255,255,255,0.5)"
      }
      frameCountRef.current += 1

      ctx.clearRect(0, 0, width, height)

      const barCount = Math.min(bufferLength, 64)
      if (barCount === 0) {
        return
      }

      const barWidth = width / barCount
      const gap = Math.max(1, barWidth * 0.2)
      ctx.fillStyle = colorRef.current

      for (let i = 0; i < barCount; i++) {
        const value = dataArray[i] / 255
        const barHeight = Math.max(2 * dpr, value * height * 0.85)

        const x = i * barWidth + gap / 2
        const y = (height - barHeight) / 2

        ctx.globalAlpha = 0.15 + value * 0.45
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth - gap, barHeight, 1.5 * dpr)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    draw()
    return () => {
      cancelAnimationFrame(rafRef.current)
      resizeObserver?.disconnect()
    }
  }, [analyserRef])

  return (
    <canvas
      ref={canvasRef}
      className="music-waveform"
      aria-hidden="true"
    />
  )
}

// ---------------------------------------------------------------------------
// MusicPlayer
// ---------------------------------------------------------------------------

export function MusicPlayer() {
  const {
    status,
    mood,
    error,
    currentPromptLabel,
    elapsedSeconds,
    userHint,
    lyrics,
    analyserRef,
    togglePlayPause,
    play,
    selectMood,
    stop,
    setUserHint,
    toggleLyrics,
  } = useLyriaMusic()

  const [localHint, setLocalHint] = useState(userHint)

  const isActive = status === "playing" || status === "paused" || status === "loading"
  const preloadMusic = useCallback(() => {
    void preloadLyriaMusic()
  }, [])

  const handlePlay = useCallback(() => {
    // Sync the local hint to state before playing
    setUserHint(localHint)
    play()
  }, [localHint, play, setUserHint])

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
      {/* Waveform visualization */}
      {isActive && <Waveform analyserRef={analyserRef} />}

      {/* Playback row */}
      <div className="music-player-row">
        <button
          className={`music-play-btn${isActive ? " music-play-btn--active" : ""}`}
          onClick={togglePlayPause}
          onMouseEnter={preloadMusic}
          onFocus={preloadMusic}
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

        {/* Progress bar + info */}
        <div className="music-player-center">
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
            <span className="music-track-duration">
              {isActive ? formatTime(elapsedSeconds) : ""}
            </span>
          </div>
          {isActive && (
            <div className="music-progress">
              <div
                className="music-progress-fill"
                style={{
                  width: `${Math.min(100, (elapsedSeconds / 600) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Mood chips + lyrics toggle */}
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
        <button
          className={`music-mood-chip music-lyrics-toggle${lyrics ? " music-mood-chip--selected" : ""}`}
          onClick={toggleLyrics}
          aria-label={lyrics ? "Disable lyrics" : "Enable lyrics"}
          title={lyrics ? "Lyrics on" : "Lyrics off"}
        >
          {lyrics ? <Mic size={11} /> : <MicOff size={11} />}
          <span>Lyrics</span>
        </button>
      </div>

      {/* Prompt bar with play button */}
      <div className="music-prompt-bar">
        <input
          type="text"
          className="music-prompt-input"
          placeholder="Describe your vibe..."
          value={localHint}
          onChange={(e) => setLocalHint(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              handlePlay()
            }
          }}
          maxLength={200}
        />
        <button
          className="music-prompt-submit"
          onClick={handlePlay}
          disabled={status === "loading"}
          aria-label="Play with this vibe"
        >
          <Play size={12} />
        </button>
      </div>
    </DashboardCard>
  )
}
