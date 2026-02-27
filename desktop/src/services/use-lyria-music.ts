import { useState, useEffect, useCallback } from "react"
import {
  subscribe,
  play,
  pause,
  resume,
  stop,
  setMood,
  setVolume,
  type MusicServiceState,
  type MusicMood,
} from "@/services/lyria-music"

const INITIAL_STATE: MusicServiceState = {
  status: "idle",
  mood: "Focus",
  error: null,
  currentPromptLabel: "",
  elapsedSeconds: 0,
}

export function useLyriaMusic() {
  const [state, setState] = useState<MusicServiceState>(INITIAL_STATE)

  useEffect(() => subscribe(setState), [])

  const togglePlayPause = useCallback(() => {
    if (state.status === "playing") {
      pause()
    } else if (state.status === "paused") {
      resume()
    } else {
      play(state.mood)
    }
  }, [state.status, state.mood])

  const selectMood = useCallback((mood: MusicMood) => {
    setMood(mood)
  }, [])

  const handleStop = useCallback(() => {
    stop()
  }, [])

  const handleVolume = useCallback((v: number) => {
    setVolume(v)
  }, [])

  return {
    ...state,
    togglePlayPause,
    selectMood,
    stop: handleStop,
    setVolume: handleVolume,
  }
}
