/**
 * Hydrates the in-memory stream store from a runtime resume snapshot.
 *
 * The runtime owns lifecycle truth; on conversation switch / reload we
 * apply its `(activeRun, tasks[])` snapshot once via this hook before
 * resuming live event consumption in `use-agent-event-handler`.
 */
import { useCallback, type Dispatch, type MutableRefObject } from 'react'
import { TASK_COMPLETION_INDICATOR_MS } from '@/app/chat/lib/event-transforms'
import {
  reconcileTerminalTaskKeysFromResumeTasks,
  toTaskFromResumeSnapshot,
  type ActiveRunSnapshot,
  type ResumeTaskSnapshot,
  type StreamStoreAction,
} from './store'
import type { AgentResponseTarget } from './streaming-types'

type UseResumeSnapshotOptions = {
  dispatch: Dispatch<StreamStoreAction>
  refs: {
    activeConversationIdRef: MutableRefObject<string | null>
    terminalTaskKeysRef: MutableRefObject<Set<string>>
  }
  streaming: {
    setPendingUserMessageId: Dispatch<React.SetStateAction<string | null>>
    setStreamingResponseTarget: Dispatch<
      React.SetStateAction<AgentResponseTarget | null>
    >
  }
  timers: {
    scheduleTaskRemoval: (
      runId: string,
      agentId: string,
      delayMs: number,
    ) => void
  }
}

export function useApplyResumeSnapshot({
  dispatch,
  refs,
  streaming,
  timers,
}: UseResumeSnapshotOptions) {
  const { activeConversationIdRef, terminalTaskKeysRef } = refs
  const { setPendingUserMessageId, setStreamingResponseTarget } = streaming
  const { scheduleTaskRemoval } = timers

  return useCallback(
    (args: {
      conversationId: string
      activeRun: ActiveRunSnapshot
      tasks: ResumeTaskSnapshot[]
    }) => {
      const nowMs = Date.now()
      terminalTaskKeysRef.current = reconcileTerminalTaskKeysFromResumeTasks({
        currentKeys: terminalTaskKeysRef.current,
        tasks: args.tasks,
      })
      const taskItems = args.tasks.map((task) =>
        toTaskFromResumeSnapshot(task, nowMs),
      )
      dispatch({
        type: 'hydrate-conversation',
        conversationId: args.conversationId,
        activeRun:
          args.activeRun?.uiVisibility === 'hidden' ? null : args.activeRun,
        tasks: taskItems,
      })
      if (args.conversationId === activeConversationIdRef.current) {
        setPendingUserMessageId(
          args.activeRun?.uiVisibility === 'hidden'
            ? null
            : (args.activeRun?.userMessageId ?? null),
        )
        setStreamingResponseTarget(null)
      }
      for (const task of args.tasks) {
        if (task.status === 'completed') {
          scheduleTaskRemoval(
            task.runId,
            task.agentId,
            TASK_COMPLETION_INDICATOR_MS,
          )
        }
      }
    },
    [
      activeConversationIdRef,
      dispatch,
      scheduleTaskRemoval,
      setPendingUserMessageId,
      setStreamingResponseTarget,
      terminalTaskKeysRef,
    ],
  )
}
