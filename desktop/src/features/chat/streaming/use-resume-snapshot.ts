/**
 * Hydrates the in-memory stream store from a runtime resume snapshot.
 *
 * The runtime owns lifecycle truth; on conversation switch / reload we
 * apply its `activeRun` snapshot once via this hook before resuming live
 * event consumption in `use-agent-event-handler`. Task state needs no
 * hydration here: the authoritative thread-activity rows are fetched
 * straight from the runtime's `runtime_agents` table by
 * `useThreadActivity`, and stream decorations rebuild from live events.
 */
import { useCallback, type Dispatch, type MutableRefObject } from 'react'
import type { ActiveRunSnapshot, StreamStoreAction } from './store'

type UseResumeSnapshotOptions = {
  dispatch: Dispatch<StreamStoreAction>
  refs: {
    activeConversationIdRef: MutableRefObject<string | null>
  }
  streaming: {
    setPendingUserMessageId: Dispatch<React.SetStateAction<string | null>>
  }
}

export function useApplyResumeSnapshot({
  dispatch,
  refs,
  streaming,
}: UseResumeSnapshotOptions) {
  const { activeConversationIdRef } = refs
  const { setPendingUserMessageId } = streaming

  return useCallback(
    (args: { conversationId: string; activeRun: ActiveRunSnapshot }) => {
      dispatch({
        type: 'hydrate-conversation',
        conversationId: args.conversationId,
        activeRun:
          args.activeRun?.uiVisibility === 'hidden' ? null : args.activeRun,
      })
      if (args.conversationId === activeConversationIdRef.current) {
        setPendingUserMessageId(
          args.activeRun?.uiVisibility === 'hidden'
            ? null
            : (args.activeRun?.userMessageId ?? null),
        )
      }
    },
    [activeConversationIdRef, dispatch, setPendingUserMessageId],
  )
}
