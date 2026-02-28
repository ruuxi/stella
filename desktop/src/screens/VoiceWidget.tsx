import { useEffect, useState, useRef, useCallback } from 'react'
import { Mic, Loader2 } from 'lucide-react'
import { useUiState } from '../app/state/ui-state'
import { transcribeAudio } from '../services/speech-to-text'
import { RealtimeVoiceSession } from '../services/realtime-voice'
import type { VoiceSessionEvent, VoiceSessionState } from '../services/realtime-voice'
import '../styles/voice-widget.css'

// ---------------------------------------------------------------------------
// STT Mode (existing speech-to-text recording)
// ---------------------------------------------------------------------------

const SttVoiceWidget = () => {
  const { state, updateState } = useUiState()
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioLevel, setAudioLevel] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const maxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (maxTimeoutRef.current) {
      clearTimeout(maxTimeoutRef.current)
      maxTimeoutRef.current = null
    }
    setIsRecording(false)
  }

  useEffect(() => {
    let mounted = true
    const startRecording = async () => {
      try {
        setError(null)
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (!mounted) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        streamRef.current = stream

        // Setup audio level monitoring
        const audioContext = new AudioContext()
        audioContextRef.current = audioContext
        const analyser = audioContext.createAnalyser()
        analyserRef.current = analyser
        analyser.fftSize = 256
        const source = audioContext.createMediaStreamSource(stream)
        source.connect(analyser)

        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const updateLevel = () => {
          analyser.getByteFrequencyData(dataArray)
          const sum = dataArray.reduce((acc, val) => acc + val, 0)
          const average = sum / dataArray.length
          setAudioLevel(average / 255) // Normalize to 0-1
          animationFrameRef.current = requestAnimationFrame(updateLevel)
        }
        updateLevel()

        const mediaRecorder = new MediaRecorder(stream)
        mediaRecorderRef.current = mediaRecorder
        audioChunksRef.current = []

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data)
          }
        }

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
          if (audioBlob.size === 0) {
            console.warn('Empty audio blob')
            return
          }

          try {
            const result = await transcribeAudio({ audio: audioBlob })
            if (result.text?.trim()) {
              window.electronAPI?.submitVoiceTranscript?.(result.text.trim())
            }
          } catch (err) {
            console.error('Transcription failed:', err)
          }
        }

        mediaRecorder.start(250) // Collect chunks every 250ms
        setIsRecording(true)

        // Automatically stop recording after 5 minutes
        maxTimeoutRef.current = setTimeout(() => {
          if (mounted) updateState({ isVoiceActive: false })
        }, 5 * 60 * 1000)
      } catch (err) {
        console.error('Failed to start recording:', err)
        setError('Microphone access denied')
        setTimeout(() => {
          if (mounted) updateState({ isVoiceActive: false })
        }, 3000)
      }
    }

    if (state.isVoiceActive && !isRecording) {
      void startRecording()
    } else if (!state.isVoiceActive && isRecording) {
      stopRecording()
    }

    return () => {
      mounted = false
      stopRecording()
    }
  }, [state.isVoiceActive])

  if (!state.isVoiceActive && !isRecording) return null

  return (
    <div className="voice-widget-container">
      <div className={`voice-pill ${error ? 'voice-pill--error' : ''}`}>
        <div className="voice-pill-icon-container">
          {error ? (
            <div className="voice-pill-error-icon">!</div>
          ) : (
            <div
              className="voice-pill-pulse"
              style={{ transform: `scale(${1 + audioLevel * 0.5})`, opacity: 0.5 + audioLevel * 0.5 }}
            />
          )}
          <Mic className="voice-pill-icon" size={16} />
        </div>
        <span className="voice-pill-text">
          {error ? error : 'Listening...'}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Realtime Mode (WebRTC voice-to-voice)
// ---------------------------------------------------------------------------

type TranscriptLine = {
  role: 'user' | 'assistant'
  text: string
  id: number
}

const WAVEFORM_BAR_COUNT = 24
const SMOOTHING = 0.18 // Interpolation factor per frame (lower = smoother)
const IDLE_AMPLITUDE = 0.04 // Subtle breathing height when quiet
const IDLE_SPEED = 0.0015 // Breathing cycle speed

/**
 * Resolve a CSS custom property to a hex color string for canvas use.
 * Falls back to the provided default if the property is unset.
 */
function resolveCssColor(property: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(property).trim()
  return raw || fallback
}

const RealtimeVoiceWidget = () => {
  const { state } = useUiState()
  const [sessionState, setSessionState] = useState<VoiceSessionState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])

  const sessionRef = useRef<RealtimeVoiceSession | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const transcriptIdRef = useRef(0)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Smoothed bar values (kept in a ref to avoid re-renders every frame)
  const smoothedRef = useRef<number[]>(new Array(WAVEFORM_BAR_COUNT).fill(0))

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  // Canvas waveform animation loop — draws a mirrored bar visualizer
  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      animFrameRef.current = requestAnimationFrame(drawWaveform)
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(drawWaveform)
      return
    }

    // High-DPI scaling
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = rect.width * dpr
    const h = rect.height * dpr
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const displayW = rect.width
    const displayH = rect.height

    ctx.clearRect(0, 0, displayW, displayH)

    // Get raw frequency data from analyser
    const analyser = sessionRef.current?.getAnalyser()
    const rawBars: number[] = new Array(WAVEFORM_BAR_COUNT).fill(0)

    if (analyser) {
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(dataArray)
      const binSize = Math.floor(dataArray.length / WAVEFORM_BAR_COUNT)
      for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
        let sum = 0
        for (let j = 0; j < binSize; j++) {
          sum += dataArray[i * binSize + j]
        }
        rawBars[i] = (sum / binSize) / 255
      }
    }

    // Smooth interpolation toward target values
    const smoothed = smoothedRef.current
    for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
      const target = rawBars[i]
      smoothed[i] += (target - smoothed[i]) * SMOOTHING
    }

    // Idle breathing wave (sinusoidal, runs continuously)
    const now = performance.now()

    // Resolve primary color for gradient
    const primary = resolveCssColor('--primary', '#6366f1')

    // Bar geometry
    const barGap = 3
    const barWidth = (displayW - barGap * (WAVEFORM_BAR_COUNT - 1)) / WAVEFORM_BAR_COUNT
    const maxBarH = (displayH / 2) - 2 // max half-height (bars mirror from center)
    const centerY = displayH / 2

    for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
      // Idle sine wave: each bar offset in phase to create a travelling wave
      const idlePhase = (i / WAVEFORM_BAR_COUNT) * Math.PI * 2
      const idle = (Math.sin(now * IDLE_SPEED + idlePhase) * 0.5 + 0.5) * IDLE_AMPLITUDE

      const level = Math.max(smoothed[i], idle)
      const barH = Math.max(2, level * maxBarH)

      const x = i * (barWidth + barGap)
      const radius = Math.min(barWidth / 2, barH, 3) // rounded cap radius

      // Alpha based on level
      const alpha = 0.35 + level * 0.65

      // Top half (upward from center)
      ctx.beginPath()
      ctx.roundRect(x, centerY - barH, barWidth, barH, [radius, radius, 0, 0])
      ctx.fillStyle = primary
      ctx.globalAlpha = alpha
      ctx.fill()

      // Bottom half (downward from center, mirrored)
      ctx.beginPath()
      ctx.roundRect(x, centerY, barWidth, barH, [0, 0, radius, radius])
      ctx.fillStyle = primary
      ctx.globalAlpha = alpha * 0.6
      ctx.fill()
    }

    ctx.globalAlpha = 1

    animFrameRef.current = requestAnimationFrame(drawWaveform)
  }, [])

  // Session lifecycle — guarded against React strict mode double-mount
  useEffect(() => {
    if (!state.isVoiceRtcActive) {
      // Disconnect if active
      if (sessionRef.current) {
        void sessionRef.current.disconnect()
        sessionRef.current = null
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      setSessionState('idle')
      setError(null)
      setActiveTool(null)
      setIsSpeaking(false)
      setTranscript([])
      smoothedRef.current = new Array(WAVEFORM_BAR_COUNT).fill(0)
      return
    }

    let aborted = false
    const session = new RealtimeVoiceSession()
    sessionRef.current = session

    const unsubscribe = session.on((event: VoiceSessionEvent) => {
      if (aborted) return
      switch (event.type) {
        case 'state-change':
          setSessionState(event.state)
          if (event.error) setError(event.error)
          break

        case 'user-transcript':
          if (event.isFinal) {
            setTranscript(prev => [
              ...prev,
              { role: 'user', text: event.text, id: ++transcriptIdRef.current },
            ])
          }
          break

        case 'assistant-transcript':
          if (event.isFinal) {
            setTranscript(prev => [
              ...prev,
              { role: 'assistant', text: event.text, id: ++transcriptIdRef.current },
            ])
          }
          break

        case 'tool-start':
          setActiveTool(event.name)
          break

        case 'tool-end':
          setActiveTool(null)
          break

        case 'speaking-start':
          setIsSpeaking(true)
          break

        case 'speaking-end':
          setIsSpeaking(false)
          break
      }
    })

    // Start waveform animation
    animFrameRef.current = requestAnimationFrame(drawWaveform)

    // Connect to session
    const conversationId = state.conversationId ?? 'voice-rtc'
    session.connect(conversationId).catch((err) => {
      if (aborted) return
      console.error('[VoiceWidget] Failed to connect realtime session:', err)
      setError((err as Error).message)
      setSessionState('error')
    })

    return () => {
      aborted = true
      unsubscribe()
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      void session.disconnect()
      sessionRef.current = null
    }
  }, [state.isVoiceRtcActive])

  if (!state.isVoiceRtcActive) return null

  const isConnecting = sessionState === 'connecting'
  const isConnected = sessionState === 'connected'
  const isError = sessionState === 'error'

  const statusText = isConnecting
    ? 'Connecting...'
    : isError
      ? (error ?? 'Connection error')
      : activeTool
        ? `Using ${activeTool}`
        : isSpeaking
          ? 'Speaking'
          : 'Listening'

  return (
    <div className="voice-widget-container voice-widget-container--rtc">
      {/* Transcript bubbles — float above the waveform like orb speech bubbles */}
      {transcript.length > 0 && (
        <div className="voice-rtc-transcript">
          {transcript.slice(-4).map((line) => (
            <div
              key={line.id}
              className={`voice-rtc-bubble voice-rtc-bubble--${line.role}`}
            >
              {line.text}
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      )}

      {/* Waveform — canvas-based, centered and prominent */}
      <div className="voice-rtc-waveform-area">
        <canvas ref={canvasRef} className="voice-rtc-canvas" />
      </div>

      {/* Status indicator — subtle, below the waveform */}
      <div className={`voice-rtc-status ${isError ? 'voice-rtc-status--error' : ''}`}>
        <div className="voice-rtc-status-indicator">
          {isConnecting && <Loader2 className="voice-rtc-spinner" size={10} />}
          {isConnected && (
            <div className={`voice-rtc-dot ${isSpeaking ? 'voice-rtc-dot--speaking' : ''}`} />
          )}
          {isError && <div className="voice-rtc-dot voice-rtc-dot--error" />}
        </div>
        <span className="voice-rtc-status-text">{statusText}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root widget — delegates based on mode
// ---------------------------------------------------------------------------

export const VoiceWidget = () => {
  const { state } = useUiState()

  if (state.isVoiceRtcActive) {
    return <RealtimeVoiceWidget />
  }

  return <SttVoiceWidget />
}
