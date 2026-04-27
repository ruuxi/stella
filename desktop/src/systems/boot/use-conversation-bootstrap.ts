import { useEffect } from 'react'
import { getOrCreateLocalConversationId } from '@/app/chat/services/local-chat-store'
import { useUiState } from '@/context/ui-state'
import { configurePiRuntime, getOrCreateDeviceId } from '@/platform/electron/device'
import { router } from '@/router'
import { readPersistedLastLocation } from '@/shared/lib/last-location'
import { useBootstrapState } from './bootstrap-state'

const CONVERSATION_BOOTSTRAP_TIMEOUT_MS = 45_000
const CONVERSATION_BOOTSTRAP_RETRY_MS = 350

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })

const isChatLocation = (location: string | null) =>
  !location || location === '/' || location === '/chat' || location.startsWith('/chat?')

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

            // UiState mirrors the active conversation for callers that haven't
            // migrated to the router yet (Phase 7 cleanup). Only promote it
            // into `/chat?c=<id>` when the saved startup destination is chat;
            // otherwise the bootstrap races the route restore and pulls the
            // user back to home on every launch.
            setConversationId(localConversationId)
            if (isChatLocation(readPersistedLastLocation())) {
              try {
                await router.navigate({
                  to: '/chat',
                  search: (prev: { c?: string } | undefined) => ({
                    ...(prev ?? {}),
                    c: localConversationId,
                  }),
                  replace: true,
                })
              } catch {
                // Router isn't mounted until onboarding completes. UiState
                // still carries the id, so the chat route picks it up via
                // the bootstrap-effect when it later mounts.
              }
            }
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
    // `router` is a stable module-level singleton, so it is intentionally
    // omitted from the dependency array.
  }, [bootstrapAttempt, markFailed, markPreparing, markReady, setConversationId])
}
