import { useCallback, useEffect, useRef, useState } from 'react'

const IDLE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour
const CHECK_INTERVAL_MS = 30 * 1000 // check every 30s

type UseIdleHomeVisibilityOptions = {
  hasMessages: boolean
  isStreaming: boolean
}

export function useIdleHomeVisibility({
  hasMessages,
  isStreaming,
}: UseIdleHomeVisibilityOptions) {
  const [isIdle, setIsIdle] = useState(false)
  const lastActivityRef = useRef(Date.now())

  // Only called explicitly on message send or suggestion click
  const resetIdleTimer = useCallback(() => {
    lastActivityRef.current = Date.now()
    setIsIdle(false)
  }, [])

  const forceShowHome = useCallback(() => {
    setIsIdle(true)
  }, [])

  // Periodic idle check
  useEffect(() => {
    if (!hasMessages || isStreaming || isIdle) return

    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_THRESHOLD_MS) {
        setIsIdle(true)
      }
    }, CHECK_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [hasMessages, isStreaming, isIdle])

  const showHomeContent = !hasMessages || (!isStreaming && isIdle)

  return { showHomeContent, resetIdleTimer, forceShowHome }
}
