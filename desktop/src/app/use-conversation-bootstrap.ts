import { useEffect } from 'react'
import { useConvexAuth, useMutation } from 'convex/react'
import { api } from '@/convex/api'
import { useAccountMode } from '@/hooks/use-account-mode'
import { configurePiRuntime, getOrCreateDeviceId } from '@/services/device'
import {
  buildLocalSyncMessages,
  getLocalSyncCheckpoint,
  getOrCreateLocalConversationId,
  setLocalSyncCheckpoint,
  type LocalSyncMessage,
} from '@/services/local-chat-store'
import { useUiState } from '../providers/ui-state'

const LOCAL_SYNC_CHUNK_SIZE = 100

const getUnsyncedMessages = (
  messages: LocalSyncMessage[],
  checkpoint: string | null,
): LocalSyncMessage[] => {
  if (!checkpoint) return messages

  const checkpointIndex = messages.findIndex(
    (message) => message.localMessageId === checkpoint,
  )

  if (checkpointIndex < 0) return messages

  return messages.slice(checkpointIndex + 1)
}

const chunkMessages = (
  messages: LocalSyncMessage[],
  chunkSize = LOCAL_SYNC_CHUNK_SIZE,
): LocalSyncMessage[][] => {
  if (messages.length === 0) return []

  const chunks: LocalSyncMessage[][] = []
  for (let start = 0; start < messages.length; start += chunkSize) {
    chunks.push(messages.slice(start, start + chunkSize))
  }
  return chunks
}

const restoreVoiceShortcut = () => {
  const savedShortcut = localStorage.getItem('stella-voice-shortcut')
  if (!savedShortcut) return

  window.electronAPI?.voice.setShortcut(savedShortcut)
}

const syncLocalMessages = async (
  conversationId: string,
  importLocalMessagesChunk: ReturnType<typeof useMutation>,
  cancelled: () => boolean,
) => {
  const localConversationId = getOrCreateLocalConversationId()
  const localMessages = buildLocalSyncMessages(localConversationId)
  const checkpoint = getLocalSyncCheckpoint(localConversationId)
  const unsyncedMessages = getUnsyncedMessages(localMessages, checkpoint)

  if (unsyncedMessages.length === 0) {
    return
  }

  try {
    const chunks = chunkMessages(unsyncedMessages)
    for (const chunk of chunks) {
      if (cancelled()) {
        break
      }

      await importLocalMessagesChunk({
        conversationId,
        messages: chunk,
      })
    }

    const lastSyncedMessage = unsyncedMessages[unsyncedMessages.length - 1]
    if (!cancelled() && lastSyncedMessage) {
      setLocalSyncCheckpoint(localConversationId, lastSyncedMessage.localMessageId)
    }
  } catch (syncError) {
    console.error('[useConversationBootstrap] Local message sync failed:', syncError)
  }
}

export const useConversationBootstrap = () => {
  const { setConversationId } = useUiState()
  const { isAuthenticated } = useConvexAuth()
  const accountMode = useAccountMode()
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  )
  const importLocalMessagesChunk = useMutation(
    api.events.importLocalMessagesChunk,
  )

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const hostPromise = configurePiRuntime()
      const devicePromise = getOrCreateDeviceId()
      const settleRuntime = () => Promise.allSettled([hostPromise, devicePromise])

      if (!isAuthenticated || accountMode === 'private_local') {
        if (!cancelled) {
          setConversationId(getOrCreateLocalConversationId())
        }
        await settleRuntime()
        return
      }

      if (accountMode === undefined) {
        await settleRuntime()
        return
      }

      try {
        const conversation = await getOrCreateDefaultConversation({})
        if (!cancelled && conversation?._id) {
          await syncLocalMessages(
            conversation._id,
            importLocalMessagesChunk,
            () => cancelled,
          )

          if (!cancelled) {
            setConversationId(conversation._id)
          }
        }

        restoreVoiceShortcut()
      } catch (error) {
        console.error('[useConversationBootstrap] Cloud conversation setup failed:', error)
      }

      await settleRuntime()
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [
    accountMode,
    getOrCreateDefaultConversation,
    importLocalMessagesChunk,
    isAuthenticated,
    setConversationId,
  ])
}
