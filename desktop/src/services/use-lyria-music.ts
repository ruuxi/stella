import { useState, useEffect, useCallback, useRef } from "react"
import {
  subscribe,
  play,
  pause,
  resume,
  stop,
  setMood,
  setVolume,
  setUserHint,
  setLyrics,
  getAnalyser,
  type MusicServiceState,
  type MusicMood,
} from "@/services/lyria-music"

const INITIAL_STATE: MusicServiceState = {
  status: "idle",
  mood: "Auto",
  error: null,
  currentPromptLabel: "",
  elapsedSeconds: 0,
  userHint: "",
  lyrics: false,
}

export function useLyriaMusic() {
  const [state, setState] = useState<MusicServiceState>(INITIAL_STATE)
  const analyserRef = useRef<AnalyserNode | null>(null)

  useEffect(() => subscribe(setState), [])

  // Keep analyser ref in sync
  useEffect(() => {
    if (state.status === "playing" || state.status === "paused") {
      analyserRef.current = getAnalyser()
    } else {
      analyserRef.current = null
    }
  }, [state.status])

  const togglePlayPause = useCallback(() => {
    if (state.status === "playing") {
      pause()
    } else if (state.status === "paused") {
      resume()
    } else {
      play()
    }
  }, [state.status])

  // Play always starts/cross-fades with current settings
  const handlePlay = useCallback(() => {
    play()
  }, [])

  const selectMood = useCallback((mood: MusicMood) => {
    setMood(mood)
  }, [])

  const handleStop = useCallback(() => {
    stop()
  }, [])

  const handleVolume = useCallback((v: number) => {
    setVolume(v)
  }, [])

  const handleSetHint = useCallback((hint: string) => {
    setUserHint(hint)
  }, [])

  const toggleLyrics = useCallback(() => {
    setLyrics(!state.lyrics)
  }, [state.lyrics])

  return {
    ...state,
    analyserRef,
    togglePlayPause,
    play: handlePlay,
    selectMood,
    stop: handleStop,
    setVolume: handleVolume,
    setUserHint: handleSetHint,
    toggleLyrics,
  }
}
