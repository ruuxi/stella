import { useCallback, useEffect, useRef, useState } from 'react'
import { getElectronApi } from '@/platform/electron/electron'
import type { ChatContext, ChatContextUpdate } from '@/shared/types/electron'

type UseCapturedChatContextOptions = {
  onContextUpdate?: (
    update: ChatContextUpdate | null,
    electronApi: NonNullable<ReturnType<typeof getElectronApi>>,
  ) => void
}

function normalizeChatContext(context: ChatContext | null): ChatContext | null {
  if (!context) return null
  const hasWindow = Boolean(context.window)
  const hasBrowserUrl = Boolean(context.browserUrl)
  const hasSelectedText = Boolean(context.selectedText)
  const hasAppSelection = Boolean(context.appSelection?.snapshot)
  const hasScreenshots = Boolean(context.regionScreenshots?.length)
  const hasFiles = Boolean(context.files?.length)
  const hasPendingCapture = Boolean(context.capturePending)
  const hasWindowScreenshot = Boolean(context.windowScreenshot)

  if (
    !hasWindow &&
    !hasBrowserUrl &&
    !hasSelectedText &&
    !hasAppSelection &&
    !hasScreenshots &&
    !hasFiles &&
    !hasPendingCapture &&
    !hasWindowScreenshot
  ) {
    return null
  }

  return context
}

export function useCapturedChatContext(options?: UseCapturedChatContextOptions) {
  const onContextUpdate = options?.onContextUpdate
  const [chatContextState, setChatContextState] = useState<ChatContext | null>(null)
  const [selectedTextState, setSelectedTextState] = useState<string | null>(null)
  const chatContextRef = useRef<ChatContext | null>(null)
  const selectedTextRef = useRef<string | null>(null)

  const commitContext = useCallback((nextContext: ChatContext | null) => {
    const normalizedContext = normalizeChatContext(nextContext)
    chatContextRef.current = normalizedContext
    selectedTextRef.current = normalizedContext?.selectedText ?? null
    setChatContextState(normalizedContext)
    setSelectedTextState(normalizedContext?.selectedText ?? null)
    getElectronApi()?.capture.setContext(normalizedContext)
  }, [])

  const setChatContext = useCallback(
    (
      value:
        | ChatContext
        | null
        | ((prev: ChatContext | null) => ChatContext | null),
    ) => {
      const nextContext =
        typeof value === 'function'
          ? value(chatContextRef.current)
          : value
      commitContext(nextContext)
    },
    [commitContext],
  )

  const setSelectedText = useCallback(
    (
      value:
        | string
        | null
        | ((prev: string | null) => string | null),
    ) => {
      const nextSelectedText =
        typeof value === 'function'
          ? value(selectedTextRef.current)
          : value

      const baseContext = chatContextRef.current
      const nextContext = nextSelectedText
        ? {
            ...(baseContext ?? {
              window: null,
              browserUrl: null,
              regionScreenshots: [],
            }),
            selectedText: nextSelectedText,
          }
        : (baseContext
            ? { ...baseContext, selectedText: null }
            : null)

      commitContext(nextContext)
    },
    [commitContext],
  )

  useEffect(() => {
    const electronApi = getElectronApi()
    if (!electronApi) return

    electronApi.capture
      .getContext()
      .then((context) => {
        const normalizedContext = normalizeChatContext(context)
        chatContextRef.current = normalizedContext
        selectedTextRef.current = normalizedContext?.selectedText ?? null
        setChatContextState(normalizedContext)
        setSelectedTextState(normalizedContext?.selectedText ?? null)
      })
      .catch((error) => {
        console.warn('Failed to load chat context', error)
      })

    const unsubscribe = electronApi.capture.onContext((payload) => {
      const update = (payload as ChatContextUpdate | null) ?? null
      const context = normalizeChatContext(update?.context ?? null)

      chatContextRef.current = context
      selectedTextRef.current = context?.selectedText ?? null
      setChatContextState(context)
      setSelectedTextState(context?.selectedText ?? null)
      onContextUpdate?.(update, electronApi)
    })

    return () => {
      unsubscribe?.()
    }
  }, [onContextUpdate])

  return {
    chatContext: chatContextState,
    setChatContext,
    selectedText: selectedTextState,
    setSelectedText,
  }
}
