import { useState, useEffect, useCallback, useRef } from "react"
import type { MusicServiceState } from "@/features/music/services/lyria-music"
import type { MusicMood } from "@/prompts/music"

type LyriaMusicModule = typeof import("@/features/music/services/lyria-music")

const INITIAL_STATE: MusicServiceState = {
  status: "idle",
  mood: "Auto",
  error: null,
  currentPromptLabel: "",
  elapsedSeconds: 0,
  userHint: "",
  lyrics: false,
}

let lyriaMusicModulePromise: Promise<LyriaMusicModule> | null = null

function loadLyriaMusicModule(): Promise<LyriaMusicModule> {
  if (!lyriaMusicModulePromise) {
    lyriaMusicModulePromise = import("@/features/music/services/lyria-music")
  }
  return lyriaMusicModulePromise
}

export function preloadLyriaMusic() {
  return loadLyriaMusicModule()
}

export function useLyriaMusic() {
  const [state, setState] = useState<MusicServiceState>(INITIAL_STATE)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const serviceRef = useRef<LyriaMusicModule | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const ensureService = useCallback(async (): Promise<LyriaMusicModule> => {
    if (serviceRef.current) {
      return serviceRef.current
    }

    const service = await loadLyriaMusicModule()
    serviceRef.current = service
    if (!unsubscribeRef.current) {
      unsubscribeRef.current = service.subscribe(setState)
    }
    return service
  }, [])

  useEffect(
    () => () => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    },
    [],
  )

  // Keep analyser ref in sync
  useEffect(() => {
    if (state.status === "playing" || state.status === "paused") {
      analyserRef.current = serviceRef.current?.getAnalyser() ?? null
    } else {
      analyserRef.current = null
    }
  }, [state.status])

  const runWithService = useCallback(
    (runner: (service: LyriaMusicModule) => void) => {
      void ensureService()
        .then((service) => {
          runner(service)
        })
        .catch((error) => {
          console.error("[useLyriaMusic] Failed to load music service:", error)
        })
    },
    [ensureService],
  )

  const togglePlayPause = useCallback(() => {
    runWithService((service) => {
      if (state.status === "playing") {
        service.pause()
      } else if (state.status === "paused") {
        service.resume()
      } else {
        service.play()
      }
    })
  }, [runWithService, state.status])

  // Play always starts/cross-fades with current settings
  const handlePlay = useCallback(() => {
    runWithService((service) => {
      service.play()
    })
  }, [runWithService])

  const selectMood = useCallback(
    (mood: MusicMood) => {
      runWithService((service) => {
        service.setMood(mood)
      })
    },
    [runWithService],
  )

  const handleStop = useCallback(() => {
    runWithService((service) => {
      service.stop()
    })
  }, [runWithService])

  const handleVolume = useCallback(
    (v: number) => {
      runWithService((service) => {
        service.setVolume(v)
      })
    },
    [runWithService],
  )

  const handleSetHint = useCallback(
    (hint: string) => {
      runWithService((service) => {
        service.setUserHint(hint)
      })
    },
    [runWithService],
  )

  const toggleLyrics = useCallback(() => {
    runWithService((service) => {
      service.setLyrics(!state.lyrics)
    })
  }, [runWithService, state.lyrics])

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

