import { useEffect } from 'react'
import { getOrCreateLocalConversationId } from '@/app/chat/services/local-chat-store'
import { useUiState } from '@/context/ui-state'
import { configurePiRuntime, getOrCreateDeviceId } from '@/platform/electron/device'
import { useBootstrapState } from './bootstrap-state'

const CONVERSATION_BOOTSTRAP_TIMEOUT_MS = 45_000
const CONVERSATION_BOOTSTRAP_RETRY_MS = 350

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })

export const useConversationBootstrap = () => {
  const { setConversationId } = useUiState()
  const {
    bootstrapAttempt,
    markFailed,
    markPreparing,
    markReady,
  } = useBootstrapState()

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      markPreparing()

      const hostPromise = configurePiRuntime()
      const devicePromise = getOrCreateDeviceId()
      const settleRuntime = () => Promise.allSettled([hostPromise, devicePromise])
      const settleRuntimeAndRestoreShortcut = async () => {
        await settleRuntime()
      }
      const startedAt = Date.now()

      try {
        while (!cancelled) {
          try {
            const [localConversationId] = await Promise.all([
              getOrCreateLocalConversationId(),
              settleRuntimeAndRestoreShortcut(),
            ])

            if (cancelled) {
              return
            }

            setConversationId(localConversationId)
            markReady()
            return
          } catch (error) {
            if (Date.now() - startedAt >= CONVERSATION_BOOTSTRAP_TIMEOUT_MS) {
              throw error
            }
            await wait(CONVERSATION_BOOTSTRAP_RETRY_MS)
          }
        }
      } catch (error) {
        if (cancelled) {
          return
        }

        markFailed(
          error instanceof Error && error.message
            ? error.message
            : 'Stella could not finish starting.',
        )
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [bootstrapAttempt, markFailed, markPreparing, markReady, setConversationId])
}
