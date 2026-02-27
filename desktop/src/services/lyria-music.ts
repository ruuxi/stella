import { GoogleGenAI } from "@google/genai"
import { createServiceRequest } from "@/services/http/service-request"
import {
  generateMusicPrompt,
  getFallbackPrompt,
  type MusicMood,
  type PromptSet,
} from "@/services/lyria-prompts"

export type { MusicMood } from "@/services/lyria-prompts"

export type MusicServiceState = {
  status: "idle" | "loading" | "playing" | "paused" | "error"
  mood: MusicMood
  error: string | null
  currentPromptLabel: string
  elapsedSeconds: number
  userHint: string
  lyrics: boolean
}

// ---------------------------------------------------------------------------
// Subscriber pattern
// ---------------------------------------------------------------------------

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
type LyriaSession = any

// Dual-session cross-fade: A is primary, B is standby
let sessionA: LyriaSession = null
let sessionB: LyriaSession = null
let activeSlot: "A" | "B" = "A"

let audioContext: AudioContext | null = null
let gainA: GainNode | null = null
let gainB: GainNode | null = null
let analyserNode: AnalyserNode | null = null

// Audio scheduling — per-slot next play times
let nextPlayTimeA = 0
let nextPlayTimeB = 0

// Session timing for pre-emptive reconnect
let sessionStartTime = 0
const SESSION_PREEMPT_MS = 9 * 60 * 1000 // start overlap at 9 min
let preemptTimer: ReturnType<typeof setTimeout> | null = null

// Cross-fade duration
const CROSSFADE_MS = 2000

// Cross-fade concurrency lock
let crossFadeInProgress = false

// Auto-prompt timer
let autoPromptTimer: ReturnType<typeof setInterval> | null = null
const PROMPT_CYCLE_MS = 3 * 60 * 1000

// Elapsed timer
let elapsedTimer: ReturnType<typeof setInterval> | null = null

// Current volume target (0-1)
let targetVolume = 1.0

// Intent flags
let intentionallyStopped = false

// Reconnect guard
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5

// Audio chunk counter (for debug)
let audioChunkCount = 0

// Cached API key
let cachedApiKey: string | null = null

// Current prompt set (for LLM evolution context)
let currentPromptSet: PromptSet | null = null

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

async function resolveApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey

  const { endpoint, headers } = await createServiceRequest("/api/music/api-key", {
    "Content-Type": "application/json",
  })

  const response = await fetch(endpoint, { method: "POST", headers, body: "{}" })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const msg =
      body && typeof body === "object" && "error" in body
        ? (body as { error: string }).error
        : `Failed to obtain music API key (${response.status})`
    throw new Error(msg)
  }

  const json = (await response.json()) as { apiKey?: string }
  if (typeof json.apiKey !== "string") throw new Error("Invalid API key response")

  cachedApiKey = json.apiKey
  return json.apiKey
}

// ---------------------------------------------------------------------------
// Audio graph setup
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100

function ensureAudioGraph(): {
  ctx: AudioContext
  gA: GainNode
  gB: GainNode
  analyser: AnalyserNode
} {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })

    analyserNode = audioContext.createAnalyser()
    analyserNode.fftSize = 256
    analyserNode.smoothingTimeConstant = 0.8
    analyserNode.connect(audioContext.destination)

    gainA = audioContext.createGain()
    gainA.gain.value = targetVolume
    gainA.connect(analyserNode)

    gainB = audioContext.createGain()
    gainB.gain.value = 0
    gainB.connect(analyserNode)
  }
  return { ctx: audioContext, gA: gainA!, gB: gainB!, analyser: analyserNode! }
}

export function getAnalyser(): AnalyserNode | null {
  return analyserNode
}

// ---------------------------------------------------------------------------
// PCM16 audio chunk handler — routes to the correct gain node
// ---------------------------------------------------------------------------

function createAudioHandler(slot: "A" | "B") {
  return (message: { serverContent?: { audioChunks?: { data?: string }[] } }) => {
    const chunks = message.serverContent?.audioChunks
    if (!chunks) return

    audioChunkCount++
    if (audioChunkCount === 1) reconnectAttempts = 0

    const { ctx } = ensureAudioGraph()
    const gain = slot === "A" ? gainA! : gainB!

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

      const buffer = ctx.createBuffer(2, sampleCount, SAMPLE_RATE)
      buffer.copyToChannel(left, 0)
      buffer.copyToChannel(right, 1)

      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(gain)

      const now = ctx.currentTime
      let nextTime = slot === "A" ? nextPlayTimeA : nextPlayTimeB
      if (nextTime < now) {
        nextTime = now + 0.05
      }
      source.start(nextTime)
      nextTime += buffer.duration

      if (slot === "A") nextPlayTimeA = nextTime
      else nextPlayTimeB = nextTime
    }
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function createSession(
  slot: "A" | "B",
  promptSet: PromptSet,
): Promise<LyriaSession> {
  const apiKey = await resolveApiKey()

  const client = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" })

  const { ctx } = ensureAudioGraph()
  if (ctx.state === "suspended") await ctx.resume()

  // Reset scheduling for this slot
  if (slot === "A") nextPlayTimeA = 0
  else nextPlayTimeB = 0

  const session = await client.live.music.connect({
    model: "models/lyria-realtime-exp",
    callbacks: {
      onmessage: createAudioHandler(slot),
      onerror: (error: unknown) => {
        console.error(`[lyria-music] session ${slot} error:`, error)
      },
      onclose: (event: unknown) => {
        const closeEvent = event as { code?: number; reason?: string } | undefined
        const code = closeEvent?.code ?? 0
        const reason = closeEvent?.reason ?? ""
        console.warn(`[lyria-music] session ${slot} closed`, code, reason)

        // Clear the closed session reference
        if (slot === "A") sessionA = null
        else sessionB = null

        const isQuotaOrAuthError =
          code === 1007 || code === 1011 || code === 1008 || code === 1003
        if (isQuotaOrAuthError) {
          cachedApiKey = null
          setState({
            status: "error",
            error: reason.slice(0, 100) || "Connection rejected by server",
          })
          return
        }

        // If the active session closed unexpectedly, try to recover
        if (
          slot === activeSlot &&
          !intentionallyStopped &&
          state.status === "playing" &&
          reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
          !crossFadeInProgress
        ) {
          reconnectAttempts++
          console.log(
            `[lyria-music] unexpected close, reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
          )
          crossFadeToNewSession().catch((err) => {
            setState({
              status: "error",
              error: err instanceof Error ? err.message : "Reconnection failed",
            })
          })
        }
      },
    },
  })

  await session.setWeightedPrompts({ weightedPrompts: promptSet.prompts })
  await session.setMusicGenerationConfig({
    musicGenerationConfig: {
      bpm: promptSet.config.bpm,
      density: promptSet.config.density,
      brightness: promptSet.config.brightness,
      guidance: promptSet.config.guidance,
      temperature: promptSet.config.temperature,
      ...(state.lyrics ? { music_generation_mode: "VOCALIZATION" } : {}),
    },
  })

  await session.play()
  return session
}

// ---------------------------------------------------------------------------
// Fire-and-forget session stop (never hangs)
// ---------------------------------------------------------------------------

function killSession(session: LyriaSession) {
  if (!session) return
  try {
    session.stop()
  } catch {
    // ignore — best effort
  }
}

// ---------------------------------------------------------------------------
// Cross-fade logic
// ---------------------------------------------------------------------------

async function crossFadeToNewSession(): Promise<void> {
  if (crossFadeInProgress) {
    console.warn("[lyria-music] cross-fade already in progress, skipping")
    return
  }
  crossFadeInProgress = true

  try {
    const { ctx } = ensureAudioGraph()

    // Snapshot which slot is old/new at entry time
    const oldSlot = activeSlot
    const newSlot = oldSlot === "A" ? "B" : "A"
    const oldGain = oldSlot === "A" ? gainA! : gainB!
    const newGain = newSlot === "A" ? gainA! : gainB!

    // Kill any leftover session on the standby slot
    const leftover = newSlot === "A" ? sessionA : sessionB
    if (leftover) {
      killSession(leftover)
      if (newSlot === "A") sessionA = null
      else sessionB = null
    }

    // Generate a new prompt via LLM for the transition
    const promptSet = await generateMusicPrompt(
      state.mood,
      currentPromptSet?.label ?? null,
      state.userHint || null,
      state.lyrics,
    )
    currentPromptSet = promptSet

    // Bail if we were stopped while awaiting the LLM
    if (intentionallyStopped) return

    // Start new session on the standby slot (initially silent)
    const now = ctx.currentTime
    newGain.gain.cancelScheduledValues(now)
    newGain.gain.setValueAtTime(0, now)

    const newSession = await createSession(newSlot, promptSet)

    // Bail if we were stopped while creating session
    if (intentionallyStopped) {
      killSession(newSession)
      return
    }

    if (newSlot === "A") sessionA = newSession
    else sessionB = newSession

    // Cross-fade: fade out old, fade in new
    const fadeNow = ctx.currentTime
    const fadeDuration = CROSSFADE_MS / 1000
    oldGain.gain.cancelScheduledValues(fadeNow)
    oldGain.gain.setValueAtTime(oldGain.gain.value, fadeNow)
    oldGain.gain.linearRampToValueAtTime(0, fadeNow + fadeDuration)

    newGain.gain.setValueAtTime(0, fadeNow)
    newGain.gain.linearRampToValueAtTime(targetVolume, fadeNow + fadeDuration)

    // After fade completes, clean up old session
    // Use captured oldSlot (not activeSlot which may have changed)
    setTimeout(() => {
      const oldSession = oldSlot === "A" ? sessionA : sessionB
      if (oldSession) {
        killSession(oldSession)
        if (oldSlot === "A") sessionA = null
        else sessionB = null
      }

      // Swap active slot
      activeSlot = newSlot
      sessionStartTime = Date.now()
      schedulePreemptiveReconnect()

      setState({ currentPromptLabel: promptSet.label })
    }, CROSSFADE_MS + 200)
  } finally {
    crossFadeInProgress = false
  }
}

// ---------------------------------------------------------------------------
// Pre-emptive reconnect (before 10-min limit)
// ---------------------------------------------------------------------------

function schedulePreemptiveReconnect() {
  clearPreemptTimer()
  const remaining = SESSION_PREEMPT_MS - (Date.now() - sessionStartTime)
  if (remaining <= 0) return

  preemptTimer = setTimeout(async () => {
    if (intentionallyStopped || state.status !== "playing") return
    console.log("[lyria-music] pre-emptive session overlap starting...")
    try {
      await crossFadeToNewSession()
    } catch (err) {
      console.warn("[lyria-music] pre-emptive reconnect failed:", err)
    }
  }, remaining)
}

function clearPreemptTimer() {
  if (preemptTimer) {
    clearTimeout(preemptTimer)
    preemptTimer = null
  }
}

// ---------------------------------------------------------------------------
// LLM auto-prompt cycling
// ---------------------------------------------------------------------------

function startAutoPromptCycle() {
  stopAutoPromptCycle()

  autoPromptTimer = setInterval(async () => {
    if (!getActiveSession() || state.status !== "playing") return
    if (crossFadeInProgress) return

    try {
      const promptSet = await generateMusicPrompt(
        state.mood,
        currentPromptSet?.label ?? null,
        state.userHint || null,
        state.lyrics,
      )
      currentPromptSet = promptSet

      const session = getActiveSession()
      if (!session) return

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
      // Non-fatal
    }
  }, PROMPT_CYCLE_MS)
}

function stopAutoPromptCycle() {
  if (autoPromptTimer) {
    clearInterval(autoPromptTimer)
    autoPromptTimer = null
  }
}

function getActiveSession(): LyriaSession {
  return activeSlot === "A" ? sessionA : sessionB
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

function stopAllSessions() {
  stopAutoPromptCycle()
  stopElapsedTimer()
  clearPreemptTimer()

  // Kill sessions synchronously (fire-and-forget) — never hang
  killSession(sessionA)
  killSession(sessionB)
  sessionA = null
  sessionB = null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function play(): Promise<void> {
  // If already playing, cross-fade to apply current settings
  if (state.status === "playing" || state.status === "paused") {
    crossFadeToNewSession().catch((err) => {
      console.warn("[lyria-music] play cross-fade failed:", err)
    })
    return
  }

  intentionallyStopped = false
  crossFadeInProgress = false
  reconnectAttempts = 0
  audioChunkCount = 0
  setState({
    status: "loading",
    error: null,
    elapsedSeconds: 0,
  })

  try {
    stopAllSessions()

    // Generate prompt via LLM (falls back to hardcoded if LLM fails)
    const promptSet = await generateMusicPrompt(
      state.mood,
      null, // no previous — fresh start
      state.userHint || null,
      state.lyrics,
    )
    currentPromptSet = promptSet

    const { gA, gB } = ensureAudioGraph()

    // Start on slot A
    activeSlot = "A"
    gA.gain.value = targetVolume
    gB.gain.value = 0

    sessionA = await createSession("A", promptSet)
    sessionStartTime = Date.now()

    setState({
      status: "playing",
      currentPromptLabel: promptSet.label,
    })

    startElapsedTimer()
    startAutoPromptCycle()
    schedulePreemptiveReconnect()
  } catch (err) {
    setState({
      status: "error",
      error: err instanceof Error ? err.message : "Failed to start music",
    })
  }
}

export async function pause(): Promise<void> {
  const session = getActiveSession()
  if (!session) return
  try {
    await session.pause()
    setState({ status: "paused" })
    stopElapsedTimer()
    clearPreemptTimer()
  } catch {
    // ignore
  }
}

export async function resume(): Promise<void> {
  const session = getActiveSession()
  if (!session) return
  try {
    const { ctx } = ensureAudioGraph()
    if (ctx.state === "suspended") await ctx.resume()
    await session.play()
    setState({ status: "playing" })
    startElapsedTimer()
    schedulePreemptiveReconnect()
  } catch {
    // ignore
  }
}

export function stop(): void {
  intentionallyStopped = true
  crossFadeInProgress = false
  stopAllSessions()

  // Fade out smoothly
  if (audioContext && gainA && gainB) {
    const now = audioContext.currentTime
    gainA.gain.cancelScheduledValues(now)
    gainA.gain.setValueAtTime(gainA.gain.value, now)
    gainA.gain.linearRampToValueAtTime(0, now + 0.3)
    gainB.gain.cancelScheduledValues(now)
    gainB.gain.setValueAtTime(gainB.gain.value, now)
    gainB.gain.linearRampToValueAtTime(0, now + 0.3)
  }

  setState({
    status: "idle",
    error: null,
    currentPromptLabel: "",
    elapsedSeconds: 0,
  })
  currentPromptSet = null
}

export function setMood(mood: MusicMood): void {
  setState({ mood })
}

export function setVolume(volume: number): void {
  targetVolume = Math.max(0, Math.min(1, volume))
  const gain = activeSlot === "A" ? gainA : gainB
  if (gain && audioContext) {
    gain.gain.setTargetAtTime(targetVolume, audioContext.currentTime, 0.05)
  }
}

export function setUserHint(hint: string): void {
  setState({ userHint: hint })
}

export function setLyrics(enabled: boolean): void {
  setState({ lyrics: enabled })
}
