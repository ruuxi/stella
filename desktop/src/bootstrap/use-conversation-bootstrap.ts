import { useEffect } from 'react'
import { getOrCreateLocalConversationId } from '@/features/chat/services/local-chat-store'
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
      const startedAt = Date.now()

      try {
        while (!cancelled) {
          try {
            // Seed the durable active-conversation pointer (creating one on a
            // fresh install) and mirror it into UiState for callers that read
            // `state.conversationId` before the router resolves. We do NOT
            // navigate here: the `/chat` route loader is the single owner of
            // `?c=`, backfilling it from this same durable pointer. That keeps
            // one source of truth and avoids racing the route restore.
            const [localConversationId] = await Promise.all([
              getOrCreateLocalConversationId(),
              settleRuntime(),
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
