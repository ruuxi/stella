import { useEffect, useState } from 'react'
import { getElectronApi } from '@/platform/electron/electron'
import type { ChatContext, ChatContextUpdate } from '@/shared/types/electron'

type UseCapturedChatContextOptions = {
  onContextUpdate?: (
    update: ChatContextUpdate | null,
    electronApi: NonNullable<ReturnType<typeof getElectronApi>>,
  ) => void
}

export function useCapturedChatContext(options?: UseCapturedChatContextOptions) {
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
      const update = (payload as ChatContextUpdate | null) ?? null
      const context = update?.context ?? null

      setChatContext(context)
      setSelectedText(context?.selectedText ?? null)
      options?.onContextUpdate?.(update, electronApi)
    })

    return () => {
      unsubscribe?.()
    }
  }, [options?.onContextUpdate])

  return { chatContext, setChatContext, selectedText, setSelectedText }
}
