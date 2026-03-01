import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Wake word background audio capture
// Runs in the voice window renderer, streams 16kHz PCM to main process
// ---------------------------------------------------------------------------

const useWakeWordCapture = () => {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.sendWakeWordAudio || !api?.onWakeWordStartCapture) return

    let active = false

    const startCapture = async () => {
      if (active) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream

        const ctx = new AudioContext({ sampleRate: 16000 })
        contextRef.current = ctx

        const source = ctx.createMediaStreamSource(stream)

        // ScriptProcessorNode with 4096 buffer; we chunk it into 1280 samples (80ms at 16kHz)
        const bufferSize = 4096
        const processor = ctx.createScriptProcessor(bufferSize, 1, 1)
        processorRef.current = processor

        let remainder = new Float32Array(0)

        processor.onaudioprocess = (e) => {
          if (!active) return
          const input = e.inputBuffer.getChannelData(0)

          // Combine with remainder
          const combined = new Float32Array(remainder.length + input.length)
          combined.set(remainder)
          combined.set(input, remainder.length)

          // Send in 1280-sample chunks
          let offset = 0
          while (offset + 1280 <= combined.length) {
            const chunk = combined.slice(offset, offset + 1280)
            // Convert float32 [-1, 1] to int16
            const int16 = new Int16Array(1280)
            for (let i = 0; i < 1280; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, Math.round(chunk[i] * 32767)))
            }
            api.sendWakeWordAudio(int16.buffer)
            offset += 1280
          }

          remainder = combined.slice(offset)
        }

        source.connect(processor)
        processor.connect(ctx.destination)
        active = true
      } catch (err) {
        console.error('[WakeWord] Failed to start capture:', err)
      }
    }

    const stopCapture = () => {
      active = false
      if (processorRef.current) {
        processorRef.current.disconnect()
        processorRef.current = null
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      if (contextRef.current) {
        contextRef.current.close()
        contextRef.current = null
      }
    }

    const unsub1 = api.onWakeWordStartCapture(startCapture)
    const unsub2 = api.onWakeWordStopCapture(stopCapture)

    return () => {
      stopCapture()
      unsub1()
      unsub2()
    }
  }, [])
}

// ---------------------------------------------------------------------------
// VoiceWidget — wake word capture only (no UI)
// Rendered in the hidden voice window for background audio access.
// ---------------------------------------------------------------------------

export const VoiceWidget = () => {
  useWakeWordCapture()
  return null
}
