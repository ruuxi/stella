import Play from "lucide-react/dist/esm/icons/play"
import Square from "lucide-react/dist/esm/icons/square"
import { useRef, useEffect, useState, useCallback } from "react"
import { preloadLyriaMusic, useLyriaMusic } from "@/features/music/hooks/use-lyria-music"
import type { MusicMood } from "@/prompts/music"

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

      const halfCount = Math.min(bufferLength, 32)
      if (halfCount === 0) {
        return
      }

      // Total bars = halfCount * 2, mirrored from center outward
      const totalBars = halfCount * 2
      const barWidth = width / totalBars
      const gap = Math.max(1, barWidth * 0.2)
      const centerX = width / 2
      ctx.fillStyle = colorRef.current

      for (let i = 0; i < halfCount; i++) {
        const value = dataArray[i] / 255
        const barHeight = Math.max(2 * dpr, value * height * 0.85)
        const y = height - barHeight

        ctx.globalAlpha = 0.15 + value * 0.45

        // Right side: center outward
        const xRight = centerX + i * barWidth + gap / 2
        ctx.beginPath()
        ctx.roundRect(xRight, y, barWidth - gap, barHeight, 1.5 * dpr)
        ctx.fill()

        // Left side: mirror
        const xLeft = centerX - (i + 1) * barWidth + gap / 2
        ctx.beginPath()
        ctx.roundRect(xLeft, y, barWidth - gap, barHeight, 1.5 * dpr)
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
    <div
      className="dashboard-card"
      data-stella-label="Music Player"
      data-stella-state={`status: ${status} | mood: ${mood}${isActive ? ` | elapsed: ${formatTime(elapsedSeconds)}` : ""}${lyrics ? " | lyrics: on" : ""}`}
    >
      {/* Waveform visualization */}
      {isActive && <Waveform analyserRef={analyserRef} />}

      {/* Left: Prompt bar + track info */}
      <div className="music-left-group" data-active={isActive || undefined}>
        <div className="music-prompt-bar">
          <input
            type="text"
            className="music-prompt-input"
            placeholder="Describe your vibe..."
            data-stella-action="Music vibe prompt"
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
        </div>
        {isActive && (
          <div className="music-track-info">
            <span className="music-track-title">
              {error
                ? "Unable to play"
                : status === "loading"
                  ? "Starting..."
                  : currentPromptLabel || mood}
            </span>
            <span className="music-track-duration">
              {formatTime(elapsedSeconds)}
            </span>
          </div>
        )}
      </div>

      {/* Center: Play/Stop button */}
      <button
        className={`music-play-btn${isActive ? " music-play-btn--active" : ""}`}
        onClick={isActive ? stop : handlePlay}
        onMouseEnter={preloadMusic}
        onFocus={preloadMusic}
        disabled={status === "loading"}
        aria-label={isActive ? "Stop" : "Play"}
        data-stella-action={isActive ? "Stop music" : "Play music"}
      >
        {status === "loading" ? (
          <span className="music-loading-dot" />
        ) : isActive ? (
          <Square size={14} />
        ) : (
          <Play size={14} />
        )}
      </button>

      {/* Right side: Mood chips + Lyrics toggle */}
      <div className="music-right-group">
        <div className="music-moods">
          {MOODS.map((m) => (
            <button
              key={m}
              className={`music-mood-chip${m === mood ? " music-mood-chip--selected" : ""}`}
              onClick={() => selectMood(m)}
              data-stella-action={`Set mood: ${m}`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className={`music-lyrics-toggle${lyrics ? " music-lyrics-toggle--active" : ""}`} onClick={toggleLyrics} role="button" tabIndex={0} aria-label={lyrics ? "Disable lyrics" : "Enable lyrics"}>
          <span className="music-lyrics-label">Lyrics</span>
          <div className={`music-lyrics-switch${lyrics ? " music-lyrics-switch--on" : ""}`}>
            <div className="music-lyrics-switch-thumb" />
          </div>
        </div>
      </div>
    </div>
  )
}

