import { useEffect } from 'react'
import { configurePiRuntime, getOrCreateDeviceId } from '@/platform/electron/device'
import { getOrCreateLocalConversationId } from '@/app/chat/services/local-chat-store'
import { useUiState } from '@/context/ui-state'

const restoreVoiceShortcut = () => {
  const savedShortcut = localStorage.getItem('stella-voice-shortcut')
  if (!savedShortcut) return

  window.electronAPI?.voice.setShortcut(savedShortcut)
}

export const useConversationBootstrap = () => {
  const { setConversationId } = useUiState()

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const hostPromise = configurePiRuntime()
      const devicePromise = getOrCreateDeviceId()
      const settleRuntime = () => Promise.allSettled([hostPromise, devicePromise])
      const settleRuntimeAndRestoreShortcut = async () => {
        await settleRuntime()
        restoreVoiceShortcut()
      }

      const [localConversationId] = await Promise.all([
        getOrCreateLocalConversationId(),
        settleRuntimeAndRestoreShortcut(),
      ])
      if (!cancelled) {
        setConversationId(localConversationId)
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [setConversationId])
}
