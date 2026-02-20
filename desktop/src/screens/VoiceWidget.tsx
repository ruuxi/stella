import { useEffect, useState, useRef } from 'react'
import { Mic } from 'lucide-react'
import { useUiState } from '../app/state/ui-state'
import { transcribeAudio } from '../services/speech-to-text'
import '../styles/voice-widget.css'

export const VoiceWidget = () => {
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
            // Error handling could be expanded here to show a toast or notification
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
        // Auto-close after a few seconds on error
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

  // Only render if voice is active or we are fading out
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
