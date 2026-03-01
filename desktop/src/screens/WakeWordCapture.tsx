/**
 * Headless component for wake word audio capture.
 *
 * Rendered in a hidden BrowserWindow. Captures microphone audio via
 * Web Audio API, resamples to 16kHz mono, and streams Int16 PCM chunks
 * to the main process via IPC for wake word detection.
 */

import { useEffect, useRef } from 'react'

export const WakeWordCapture = () => {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const activeRef = useRef(false)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.sendWakeWordAudio || !api?.onWakeWordStartCapture) return

    const startCapture = async () => {
      if (activeRef.current) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream

        // Use native sample rate — forcing 16kHz can cause silent/broken capture
        const ctx = new AudioContext()
        contextRef.current = ctx

        const source = ctx.createMediaStreamSource(stream)
        const actualRate = ctx.sampleRate

        // ScriptProcessorNode — bufferSize must be power of 2
        const bufferSize = 4096
        const processor = ctx.createScriptProcessor(bufferSize, 1, 1)
        processorRef.current = processor

        let remainder = new Float32Array(0)

        processor.onaudioprocess = (e) => {
          if (!activeRef.current) return

          let input = e.inputBuffer.getChannelData(0)

          // Resample if browser gave us a different rate than 16kHz
          if (actualRate !== 16000) {
            const ratio = 16000 / actualRate
            const newLen = Math.round(input.length * ratio)
            const resampled = new Float32Array(newLen)
            for (let i = 0; i < newLen; i++) {
              const srcIdx = i / ratio
              const lo = Math.floor(srcIdx)
              const hi = Math.min(lo + 1, input.length - 1)
              const frac = srcIdx - lo
              resampled[i] = input[lo] * (1 - frac) + input[hi] * frac
            }
            input = resampled
          }

          // Combine with remainder from previous buffer
          const combined = new Float32Array(remainder.length + input.length)
          combined.set(remainder)
          combined.set(input, remainder.length)

          // Send in 1280-sample (80ms) chunks
          let offset = 0
          while (offset + 1280 <= combined.length) {
            const chunk = combined.subarray(offset, offset + 1280)
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
        activeRef.current = true
      } catch (err) {
        console.error('[WakeWordCapture] Failed to start:', err)
      }
    }

    const stopCapture = () => {
      activeRef.current = false
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

    // Tell main process we're mounted and ready to receive start/stop commands.
    // This fixes a race where start-capture arrives before the component mounts.
    api.signalWakeWordReady?.()

    return () => {
      stopCapture()
      unsub1()
      unsub2()
    }
  }, [])

  // No UI — this is a headless capture component
  return null
}
