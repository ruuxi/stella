import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { ViewType } from '@/types/ui'
import type { FloatingOrbHandle } from './FloatingOrb'

type UseFullShellVoiceTranscriptOptions = {
  activeView: ViewType
  orbRef: RefObject<FloatingOrbHandle | null>
  setMessage: Dispatch<SetStateAction<string>>
}

export function useFullShellVoiceTranscript({
  activeView,
  orbRef,
  setMessage,
}: UseFullShellVoiceTranscriptOptions) {
  const activeViewRef = useRef(activeView)

  useEffect(() => {
    activeViewRef.current = activeView
  }, [activeView])

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (activeViewRef.current === 'chat') {
        setMessage(text)
        return
      }

      orbRef.current?.openWithText(text)
    },
    [orbRef, setMessage],
  )

  useEffect(() => {
    const unsubscribe = window.electronAPI?.voice.onTranscript?.(handleVoiceTranscript)
    return () => unsubscribe?.()
  }, [handleVoiceTranscript])
}
