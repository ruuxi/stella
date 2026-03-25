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

type MusicStreamEvent =
  | { type: "audio"; chunks?: Array<{ data?: string }> }
  | { type: "ready"; promptLabel?: string }
  | { type: "close"; code?: number; reason?: string }
  | { type: "error"; message?: string }

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
let nextPlayTime = 0

let elapsedTimer: ReturnType<typeof setInterval> | null = null
let activeStreamController: AbortController | null = null
let playbackGeneration = 0
let targetVolume = 1.0
let intentionallyStopped = false

const SAMPLE_RATE = 44100

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
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })

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

function stopActiveStream() {
  const controller = activeStreamController
  activeStreamController = null
  if (controller && !controller.signal.aborted) {
    controller.abort()
  }
}

function fadeOutAudio() {
  if (!audioContext || !masterGain) {
    return
  }

  const now = audioContext.currentTime
  masterGain.gain.cancelScheduledValues(now)
  masterGain.gain.setValueAtTime(masterGain.gain.value, now)
  masterGain.gain.linearRampToValueAtTime(0, now + 0.3)
}

function scheduleAudioChunks(chunks: Array<{ data?: string }>) {
  if (!chunks.length) {
    return
  }

  const { ctx, gain } = ensureAudioGraph()

  for (const chunk of chunks) {
    if (!chunk.data) continue

    const binaryStr = atob(chunk.data)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }

    const int16 = new Int16Array(bytes.buffer)
    const sampleCount = int16.length / 2
    const left = new Float32Array(sampleCount)
    const right = new Float32Array(sampleCount)

    for (let i = 0; i < sampleCount; i++) {
      left[i] = int16[i * 2] / 32768
      right[i] = int16[i * 2 + 1] / 32768
    }

    const audioBuffer = ctx.createBuffer(2, sampleCount, SAMPLE_RATE)
    audioBuffer.copyToChannel(left, 0)
    audioBuffer.copyToChannel(right, 1)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(gain)

    const now = ctx.currentTime
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.05
    }

    source.start(nextPlayTime)
    nextPlayTime += audioBuffer.duration
  }
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

function applyStreamEvent(
  event: MusicStreamEvent,
  generation: number,
  streamController: AbortController,
): { sawTerminalError: boolean } {
  if (generation !== playbackGeneration || streamController.signal.aborted) {
    return { sawTerminalError: false }
  }

  switch (event.type) {
    case "audio":
      scheduleAudioChunks(event.chunks ?? [])
      return { sawTerminalError: false }
    case "ready":
      if (typeof event.promptLabel === "string" && event.promptLabel.trim()) {
        setState({ currentPromptLabel: event.promptLabel.trim() })
      }
      return { sawTerminalError: false }
    case "close":
      return { sawTerminalError: false }
    case "error": {
      const message = event.message?.trim() || "Music stream failed."
      stopElapsedTimer()
      setState({
        status: "error",
        error: message,
      })
      return { sawTerminalError: true }
    }
  }
}

async function consumeMusicStream(
  body: ReadableStream<Uint8Array>,
  generation: number,
  streamController: AbortController,
) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let sawTerminalError = false

  const flushLine = (line: string) => {
    if (!line.startsWith("data:")) {
      return
    }

    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") {
      return
    }

    const event = JSON.parse(payload) as MusicStreamEvent
    const result = applyStreamEvent(event, generation, streamController)
    if (result.sawTerminalError) {
      sawTerminalError = true
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })

      let lineBreakIndex = buffer.indexOf("\n")
      while (lineBreakIndex !== -1) {
        const line = buffer.slice(0, lineBreakIndex).trim()
        buffer = buffer.slice(lineBreakIndex + 1)
        if (line) {
          flushLine(line)
        }
        lineBreakIndex = buffer.indexOf("\n")
      }

      if (done) {
        const trailingLine = buffer.trim()
        if (trailingLine) {
          flushLine(trailingLine)
        }
        break
      }
    }

    if (
      generation === playbackGeneration &&
      !streamController.signal.aborted &&
      !intentionallyStopped &&
      !sawTerminalError
    ) {
      stopElapsedTimer()
      setState({
        status: "error",
        error: "Music stream ended unexpectedly.",
      })
    }
  } catch (error) {
    const isAbortError =
      error instanceof DOMException && error.name === "AbortError"
    if (
      !isAbortError &&
      generation === playbackGeneration &&
      !streamController.signal.aborted
    ) {
      stopElapsedTimer()
      setState({
        status: "error",
        error:
          error instanceof Error ? error.message : "Music stream failed.",
      })
    }
  } finally {
    if (activeStreamController === streamController) {
      activeStreamController = null
    }
  }
}

export async function play(): Promise<void> {
  const generation = ++playbackGeneration
  intentionallyStopped = false
  stopActiveStream()
  stopElapsedTimer()
  nextPlayTime = 0

  setState({
    status: "loading",
    error: null,
    elapsedSeconds: 0,
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

    const { ctx, gain } = ensureAudioGraph()
    if (ctx.state === "suspended") {
      await ctx.resume()
    }

    gain.gain.cancelScheduledValues(ctx.currentTime)
    gain.gain.setValueAtTime(targetVolume, ctx.currentTime)

    const { endpoint, headers } = await createServiceRequest("/api/music/stream", {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    })

    if (generation !== playbackGeneration) {
      return
    }

    const streamController = new AbortController()
    activeStreamController = streamController

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
          ...(state.lyrics ? { music_generation_mode: "VOCALIZATION" } : {}),
        },
      }),
      signal: streamController.signal,
    })

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response))
    }

    if (!response.body) {
      throw new Error("Music stream response body was empty.")
    }

    if (generation !== playbackGeneration) {
      streamController.abort()
      return
    }

    setState({
      status: "playing",
      error: null,
      currentPromptLabel: promptSet.label,
      elapsedSeconds: 0,
    })

    startElapsedTimer()
    void consumeMusicStream(
      response.body,
      generation,
      streamController,
    )
  } catch (error) {
    const isAbortError =
      error instanceof DOMException && error.name === "AbortError"
    if (generation !== playbackGeneration || isAbortError) {
      return
    }

    stopActiveStream()
    stopElapsedTimer()
    setState({
      status: "error",
      error: error instanceof Error ? error.message : "Failed to start music",
    })
  }
}

export async function pause(): Promise<void> {
  if (state.status !== "playing") {
    return
  }

  const { ctx, gain } = ensureAudioGraph()
  gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05)
  stopElapsedTimer()
  setState({ status: "paused" })
}

export async function resume(): Promise<void> {
  if (state.status !== "paused") {
    return
  }

  const { ctx, gain } = ensureAudioGraph()
  if (ctx.state === "suspended") {
    await ctx.resume()
  }
  gain.gain.setTargetAtTime(targetVolume, ctx.currentTime, 0.05)
  startElapsedTimer()
  setState({ status: "playing" })
}

export function stop(): void {
  playbackGeneration += 1
  intentionallyStopped = true
  stopActiveStream()
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
