import { GoogleGenAI } from "@google/genai"
import { createServiceRequest } from "@/services/http/service-request"
import { getPromptsForMood, type MusicMood } from "@/services/lyria-prompts"

export type { MusicMood } from "@/services/lyria-prompts"

export type MusicServiceState = {
  status: "idle" | "loading" | "playing" | "paused" | "error"
  mood: MusicMood
  error: string | null
  currentPromptLabel: string
  elapsedSeconds: number
}

// ---------------------------------------------------------------------------
// Subscriber pattern
// ---------------------------------------------------------------------------

type StateListener = (state: MusicServiceState) => void

let listeners: StateListener[] = []

let state: MusicServiceState = {
  status: "idle",
  mood: "Focus",
  error: null,
  currentPromptLabel: "",
  elapsedSeconds: 0,
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

// ---------------------------------------------------------------------------
// Internal refs
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null
let audioContext: AudioContext | null = null
let gainNode: GainNode | null = null

// Audio scheduling
let nextPlayTime = 0

// Auto-prompt timer
let autoPromptTimer: ReturnType<typeof setInterval> | null = null
let promptCycleIndex = 0
const PROMPT_CYCLE_MS = 3 * 60 * 1000 // 3 minutes

// Elapsed timer
let elapsedTimer: ReturnType<typeof setInterval> | null = null

// Flag to track intentional stops vs auto-reconnects
let intentionallyStopped = false

// Reconnection guard
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 2000

// Cached API key (only lives in memory)
let cachedApiKey: string | null = null

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

async function resolveApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey

  const { endpoint, headers } = await createServiceRequest("/api/music/api-key", {
    "Content-Type": "application/json",
  })

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: "{}",
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const msg =
      body && typeof body === "object" && "error" in body
        ? (body as { error: string }).error
        : `Failed to obtain music API key (${response.status})`
    throw new Error(msg)
  }

  const json = (await response.json()) as { apiKey?: string }
  if (typeof json.apiKey !== "string") {
    throw new Error("Invalid API key response")
  }

  cachedApiKey = json.apiKey
  return json.apiKey
}

// ---------------------------------------------------------------------------
// Web Audio API — PCM16 stereo playback
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100

function ensureAudioContext(): { ctx: AudioContext; gain: GainNode } {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
    gainNode = audioContext.createGain()
    gainNode.connect(audioContext.destination)
  }
  return { ctx: audioContext, gain: gainNode! }
}

let audioChunkCount = 0

function handleAudioMessage(message: {
  serverContent?: { audioChunks?: { data?: string }[] }
}) {
  const chunks = message.serverContent?.audioChunks
  if (!chunks) return

  audioChunkCount++
  if (audioChunkCount === 1) reconnectAttempts = 0 // Session confirmed working
  if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
    console.log(`[lyria-music] audio chunk #${audioChunkCount}, ${chunks.length} chunk(s)`)
  }

  const { ctx, gain } = ensureAudioContext()

  for (const chunk of chunks) {
    if (!chunk.data) continue

    // Base64 → Uint8Array (browser-safe, no Node Buffer)
    const binaryStr = atob(chunk.data)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }

    // PCM16 → Float32
    const int16 = new Int16Array(bytes.buffer)
    const sampleCount = int16.length / 2 // stereo interleaved
    const left = new Float32Array(sampleCount)
    const right = new Float32Array(sampleCount)

    for (let i = 0; i < sampleCount; i++) {
      left[i] = int16[i * 2] / 32768
      right[i] = int16[i * 2 + 1] / 32768
    }

    // Create AudioBuffer and schedule
    const buffer = ctx.createBuffer(2, sampleCount, SAMPLE_RATE)
    buffer.copyToChannel(left, 0)
    buffer.copyToChannel(right, 1)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gain)

    const now = ctx.currentTime
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.05 // tiny offset to avoid click
    }
    source.start(nextPlayTime)
    nextPlayTime += buffer.duration
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession(mood: MusicMood): Promise<void> {
  console.log("[lyria-music] starting session for mood:", mood)
  const apiKey = await resolveApiKey()
  console.log("[lyria-music] API key resolved, connecting...")

  const client = new GoogleGenAI({
    apiKey,
    apiVersion: "v1alpha",
  })

  const { ctx } = ensureAudioContext()
  if (ctx.state === "suspended") {
    await ctx.resume()
  }

  // Reset audio scheduling
  nextPlayTime = 0

  session = await client.live.music.connect({
    model: "models/lyria-realtime-exp",
    callbacks: {
      onmessage: handleAudioMessage,
      onerror: (error: unknown) => {
        console.error("[lyria-music] session error:", error)
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Music session error",
        })
      },
      onclose: (event: unknown) => {
        const closeEvent = event as { code?: number; reason?: string } | undefined
        const code = closeEvent?.code ?? 0
        const reason = closeEvent?.reason ?? ""
        console.warn("[lyria-music] session closed", code, reason)

        // Don't reconnect on quota/auth/server errors — only on normal timeouts
        const isQuotaOrAuthError = code === 1007 || code === 1011 || code === 1008 || code === 1003
        if (isQuotaOrAuthError) {
          cachedApiKey = null // Clear cached key
          setState({
            status: "error",
            error: reason.slice(0, 100) || "Connection rejected by server",
          })
          return
        }

        // Auto-reconnect on normal closures (e.g. 10-min session cap)
        if (
          !intentionallyStopped &&
          state.status === "playing" &&
          reconnectAttempts < MAX_RECONNECT_ATTEMPTS
        ) {
          reconnectAttempts++
          session = null
          console.log(
            `[lyria-music] reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
          )
          setTimeout(() => {
            startSession(state.mood).catch((err) => {
              setState({
                status: "error",
                error: err instanceof Error ? err.message : "Reconnection failed",
              })
            })
          }, RECONNECT_DELAY_MS)
        } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          setState({
            status: "error",
            error: "Connection lost — please try again",
          })
        }
      },
    },
  })

  console.log("[lyria-music] connected, setting prompts...")

  const promptSet = getPromptsForMood(mood, promptCycleIndex)

  await session.setWeightedPrompts({
    weightedPrompts: promptSet.prompts,
  })

  await session.setMusicGenerationConfig({
    musicGenerationConfig: {
      bpm: promptSet.config.bpm,
      density: promptSet.config.density,
      brightness: promptSet.config.brightness,
      guidance: promptSet.config.guidance,
      temperature: promptSet.config.temperature,
    },
  })

  await session.play()
  console.log("[lyria-music] playback started")
}

// ---------------------------------------------------------------------------
// Auto-prompt cycling
// ---------------------------------------------------------------------------

function startAutoPromptCycle(mood: MusicMood) {
  stopAutoPromptCycle()
  promptCycleIndex = 0

  autoPromptTimer = setInterval(async () => {
    if (!session || state.status !== "playing") return
    promptCycleIndex++
    const promptSet = getPromptsForMood(mood, promptCycleIndex)

    try {
      await session.setWeightedPrompts({ weightedPrompts: promptSet.prompts })
      await session.setMusicGenerationConfig({
        musicGenerationConfig: {
          density: promptSet.config.density,
          brightness: promptSet.config.brightness,
          guidance: promptSet.config.guidance,
        },
      })
      setState({ currentPromptLabel: promptSet.label })
    } catch {
      // Non-fatal — session may have closed between check and call
    }
  }, PROMPT_CYCLE_MS)
}

function stopAutoPromptCycle() {
  if (autoPromptTimer) {
    clearInterval(autoPromptTimer)
    autoPromptTimer = null
  }
}

// ---------------------------------------------------------------------------
// Elapsed time tracking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal cleanup
// ---------------------------------------------------------------------------

async function stopInternal() {
  stopAutoPromptCycle()
  stopElapsedTimer()

  if (session) {
    try {
      await session.stop()
    } catch {
      // ignore — may already be closed
    }
    session = null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function play(mood?: MusicMood): Promise<void> {
  const targetMood = mood ?? state.mood
  intentionallyStopped = false
  reconnectAttempts = 0
  audioChunkCount = 0
  setState({
    status: "loading",
    mood: targetMood,
    error: null,
    elapsedSeconds: 0,
  })

  try {
    await stopInternal()
    await startSession(targetMood)

    const promptSet = getPromptsForMood(targetMood, 0)
    setState({
      status: "playing",
      currentPromptLabel: promptSet.label,
    })

    startElapsedTimer()
    startAutoPromptCycle(targetMood)
  } catch (err) {
    setState({
      status: "error",
      error: err instanceof Error ? err.message : "Failed to start music",
    })
  }
}

export async function pause(): Promise<void> {
  if (!session) return
  try {
    await session.pause()
    setState({ status: "paused" })
    stopElapsedTimer()
  } catch {
    // ignore
  }
}

export async function resume(): Promise<void> {
  if (!session) return
  try {
    const { ctx } = ensureAudioContext()
    if (ctx.state === "suspended") await ctx.resume()
    await session.play()
    setState({ status: "playing" })
    startElapsedTimer()
  } catch {
    // ignore
  }
}

export async function stop(): Promise<void> {
  intentionallyStopped = true
  await stopInternal()
  setState({
    status: "idle",
    error: null,
    currentPromptLabel: "",
    elapsedSeconds: 0,
  })
}

export function setMood(mood: MusicMood): void {
  if (state.status === "playing" || state.status === "paused") {
    // Restart with the new mood
    play(mood)
  } else {
    setState({ mood })
  }
}

export function setVolume(volume: number): void {
  if (gainNode && audioContext) {
    gainNode.gain.setTargetAtTime(
      Math.max(0, Math.min(1, volume)),
      audioContext.currentTime,
      0.05,
    )
  }
}
