import { useEffect, useState } from 'react'
import { getElectronApi } from '@/platform/electron/electron'
import type { ChatContext, ChatContextUpdate } from '@/types/electron'

export function useChatContextSync() {
  const [chatContext, setChatContext] = useState<ChatContext | null>(null)
  const [selectedText, setSelectedText] = useState<string | null>(null)

  useEffect(() => {
    const electronApi = getElectronApi()
    if (!electronApi) return

    electronApi.capture
      .getContext()
      .then((context) => {
        if (!context) return
        setChatContext(context)
        setSelectedText(context.selectedText ?? null)
      })
      .catch((error) => {
        console.warn('Failed to load chat context', error)
      })

    const unsubscribe = electronApi.capture.onContext((payload) => {
      const context = (payload as ChatContextUpdate | null)?.context ?? null

      setChatContext(context)
      setSelectedText(context?.selectedText ?? null)
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

  return { chatContext, setChatContext, selectedText, setSelectedText }
}
