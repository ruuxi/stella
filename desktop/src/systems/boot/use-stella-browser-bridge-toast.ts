import { useEffect, useRef } from 'react'
import { showToast } from '@/ui/toast'

const formatRetryDelay = (retryMs?: number) => {
  if (!retryMs || retryMs <= 0) {
    return ''
  }

  const seconds = Math.max(1, Math.round(retryMs / 1000))
  return ` Stella will keep retrying in about ${seconds} second${seconds === 1 ? '' : 's'}.`
}

export const useStellaBrowserBridgeToast = () => {
  const lastToastKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('window') === 'mini') {
      return
    }

    const browserApi = window.electronAPI?.browser
    if (!browserApi?.onBridgeStatus) {
      return
    }

    return browserApi.onBridgeStatus((status) => {
      if (status.state === 'connected') {
        lastToastKeyRef.current = null
        return
      }

      if (!status.notifyUser) {
        return
      }

      const toastKey = `${status.state}:${status.attempt}:${status.error ?? ''}`
      if (lastToastKeyRef.current === toastKey) {
        return
      }

      lastToastKeyRef.current = toastKey

      const description = status.error
        ? `${status.error}.${formatRetryDelay(status.nextRetryMs)}`
        : `The Stella browser bridge disconnected.${formatRetryDelay(status.nextRetryMs)}`

      showToast({
        title: 'Browser connection lost',
        description,
        variant: 'error',
        duration: 7000,
      })
    })
  }, [])
}
