import { createServiceRequest } from "@/infra/http/service-request"
import {
  generateMusicPrompt,
  type MusicMood,
} from "@/prompts/music"

export type { MusicMood } from "@/prompts/music"
export type MusicServiceState = {
  status: "idle" | "loading" | "playing" | "paused" | "error"
  mood: MusicMood
  error: string | null
  currentPromptLabel: string
  elapsedSeconds: number
  userHint: string
  lyrics: boolean
}

type GeneratedMusicResponse = {
  audio?: {
    data?: string
    mimeType?: string
  }
  promptLabel?: string | null
  textParts?: string[]
}

type StateListener = (state: MusicServiceState) => void

let listeners: StateListener[] = []

let state: MusicServiceState = {
  status: "idle",
  mood: "Auto",
  error: null,
  currentPromptLabel: "",
  elapsedSeconds: 0,
  userHint: "",
  lyrics: false,
}

let audioContext: AudioContext | null = null
let masterGain: GainNode | null = null
let analyserNode: AnalyserNode | null = null
let currentSource: AudioBufferSourceNode | null = null

let elapsedTimer: ReturnType<typeof setInterval> | null = null
let playbackGeneration = 0
let targetVolume = 1.0
let intentionallyStopped = false

function logMusic(
  message: string,
  details?: Record<string, unknown>,
  level: "log" | "warn" | "error" = "log",
) {
  const prefix = "[lyria-music]"
  if (level === "error") {
    console.error(prefix, message, details ?? {})
  } else if (level === "warn") {
    console.warn(prefix, message, details ?? {})
  } else {
    console.log(prefix, message, details ?? {})
  }
}

function emit() {
  for (const fn of listeners) fn(state)
}

function setState(patch: Partial<MusicServiceState>) {
  state = { ...state, ...patch }
  emit()
}

export function subscribe(listener: StateListener): () => void {
  listeners.push(listener)
  listener(state)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

export function getState(): MusicServiceState {
  return state
}

function ensureAudioGraph(): {
  ctx: AudioContext
  gain: GainNode
  analyser: AnalyserNode
} {
  if (!audioContext) {
    audioContext = new AudioContext()

    analyserNode = audioContext.createAnalyser()
    analyserNode.fftSize = 256
    analyserNode.smoothingTimeConstant = 0.8
    analyserNode.connect(audioContext.destination)

    masterGain = audioContext.createGain()
    masterGain.gain.value = targetVolume
    masterGain.connect(analyserNode)
  }

  return { ctx: audioContext, gain: masterGain!, analyser: analyserNode! }
}

export function getAnalyser(): AnalyserNode | null {
  return analyserNode
}

function startElapsedTimer() {
  stopElapsedTimer()
  elapsedTimer = setInterval(() => {
    setState({ elapsedSeconds: state.elapsedSeconds + 1 })
  }, 1000)
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

function stopCurrentSource() {
  if (!currentSource) {
    return
  }

  try {
    currentSource.onended = null
    currentSource.stop()
  } catch {
    // Source may already be stopped.
  }

  try {
    currentSource.disconnect()
  } catch {
    // Ignore disconnect failures.
  }

  currentSource = null
}

function fadeOutAudio() {
  if (!audioContext || !masterGain) {
    stopCurrentSource()
    return
  }

  const now = audioContext.currentTime
  masterGain.gain.cancelScheduledValues(now)
  masterGain.gain.setValueAtTime(masterGain.gain.value, now)
  masterGain.gain.linearRampToValueAtTime(0, now + 0.2)

  window.setTimeout(() => {
    stopCurrentSource()
    if (masterGain && audioContext) {
      masterGain.gain.setValueAtTime(targetVolume, audioContext.currentTime)
    }
  }, 250)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes.buffer
}

async function parseErrorResponse(response: Response): Promise<string> {
  const body = await response.json().catch(() => null)
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === "string" && error.trim()) {
      return error
    }
  }
  return `Failed to start music (${response.status})`
}

async function playGeneratedAudio(
  payload: GeneratedMusicResponse,
  generation: number,
): Promise<void> {
  const encodedAudio = payload.audio?.data
  const mimeType = payload.audio?.mimeType
  if (!encodedAudio || !mimeType) {
    throw new Error("Music generation returned no audio.")
  }

  const { ctx, gain } = ensureAudioGraph()
  if (ctx.state === "suspended") {
    await ctx.resume()
  }

  gain.gain.cancelScheduledValues(ctx.currentTime)
  gain.gain.setValueAtTime(targetVolume, ctx.currentTime)

  stopCurrentSource()

  const decoded = await ctx.decodeAudioData(base64ToArrayBuffer(encodedAudio).slice(0))
  if (generation !== playbackGeneration) {
    return
  }

  const source = ctx.createBufferSource()
  source.buffer = decoded
  source.connect(gain)
  currentSource = source

  source.onended = () => {
    if (currentSource !== source) {
      return
    }
    currentSource = null
    stopElapsedTimer()
    if (!intentionallyStopped && generation === playbackGeneration) {
      setState({
        status: "idle",
        error: null,
        currentPromptLabel: "",
        elapsedSeconds: 0,
      })
    }
  }

  source.start(0)
  startElapsedTimer()
  setState({
    status: "playing",
    error: null,
    currentPromptLabel: payload.promptLabel?.trim() || state.currentPromptLabel,
    elapsedSeconds: 0,
  })

  logMusic("Started generated music playback.", {
    mimeType,
    durationSeconds: decoded.duration,
    textParts: payload.textParts?.length ?? 0,
  })
}

export async function play(): Promise<void> {
  const generation = ++playbackGeneration
  intentionallyStopped = false
  stopElapsedTimer()
  stopCurrentSource()

  setState({
    status: "loading",
    error: null,
    elapsedSeconds: 0,
  })
  logMusic("Starting music generation request.", {
    mood: state.mood,
    lyrics: state.lyrics,
    userHint: state.userHint,
  })

  try {
    const promptSet = await generateMusicPrompt(
      state.mood,
      null,
      state.userHint || null,
      state.lyrics,
    )

    if (generation !== playbackGeneration) {
      return
    }

    const { endpoint, headers } = await createServiceRequest("/api/music/stream", {
      Accept: "application/json",
      "Content-Type": "application/json",
    })
    logMusic("Resolved music generation endpoint.", { endpoint })

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        promptLabel: promptSet.label,
        weightedPrompts: promptSet.prompts,
        musicGenerationConfig: {
          bpm: promptSet.config.bpm,
          density: promptSet.config.density,
          brightness: promptSet.config.brightness,
          guidance: promptSet.config.guidance,
          temperature: promptSet.config.temperature,
          ...(state.lyrics ? { musicGenerationMode: "VOCALIZATION" } : {}),
        },
      }),
    })

    logMusic("Music generation HTTP response received.", {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    })

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response))
    }

    const payload = (await response.json()) as GeneratedMusicResponse
    if (generation !== playbackGeneration) {
      return
    }

    setState({
      status: "loading",
      error: null,
      currentPromptLabel: promptSet.label,
      elapsedSeconds: 0,
    })

    await playGeneratedAudio(payload, generation)
  } catch (error) {
    if (generation !== playbackGeneration) {
      return
    }

    stopCurrentSource()
    stopElapsedTimer()
    logMusic(
      "Failed to generate or play music.",
      {
        message: error instanceof Error ? error.message : "Failed to start music",
      },
      "error",
    )
    setState({
      status: "error",
      error: error instanceof Error ? error.message : "Failed to start music",
    })
  }
}

export async function pause(): Promise<void> {
  if (state.status !== "playing" || !audioContext) {
    return
  }

  await audioContext.suspend()
  stopElapsedTimer()
  setState({ status: "paused" })
}

export async function resume(): Promise<void> {
  if (state.status !== "paused" || !audioContext) {
    return
  }

  await audioContext.resume()
  startElapsedTimer()
  setState({ status: "playing" })
}

export function stop(): void {
  playbackGeneration += 1
  intentionallyStopped = true
  stopElapsedTimer()
  fadeOutAudio()

  setState({
    status: "idle",
    error: null,
    currentPromptLabel: "",
    elapsedSeconds: 0,
  })
}

export function setMood(mood: MusicMood): void {
  setState({ mood })
}

export function setVolume(volume: number): void {
  targetVolume = Math.max(0, Math.min(1, volume))
  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(targetVolume, audioContext.currentTime, 0.05)
  }
}

export function setUserHint(hint: string): void {
  setState({ userHint: hint })
}

export function setLyrics(enabled: boolean): void {
  setState({ lyrics: enabled })
}
