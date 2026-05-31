/**
 * Per-`(runId, agentId)` removal timers for completed live tasks.
 *
 * Completed tasks linger briefly on the working indicator before they
 * vanish; this hook owns the `setTimeout` registry that schedules the
 * eventual `task-remove` dispatch and clears any pending timer when the
 * task is replaced (or the hook unmounts).
 */
import { useCallback, useEffect, useRef } from 'react'
import { toRunTaskId, type StreamStoreAction } from './store'

export function useTaskRemovalTimers(
  dispatch: (action: StreamStoreAction) => void,
) {
  const liveTaskRemovalTimeoutsRef = useRef(new Map<string, number>())

  const clearScheduledTaskRemoval = useCallback(
    (runId: string, agentId: string) => {
      const key = toRunTaskId(runId, agentId)
      const timeoutId = liveTaskRemovalTimeoutsRef.current.get(key)
      if (typeof timeoutId === 'number') {
        window.clearTimeout(timeoutId)
        liveTaskRemovalTimeoutsRef.current.delete(key)
      }
    },
    [],
  )

  const scheduleTaskRemoval = useCallback(
    (runId: string, agentId: string, delayMs: number) => {
      clearScheduledTaskRemoval(runId, agentId)
      const key = toRunTaskId(runId, agentId)
      const timeoutId = window.setTimeout(() => {
        liveTaskRemovalTimeoutsRef.current.delete(key)
        dispatch({
          type: 'task-remove',
          runId,
          agentId,
        })
      }, delayMs)
      liveTaskRemovalTimeoutsRef.current.set(key, timeoutId)
    },
    [clearScheduledTaskRemoval, dispatch],
  )

  const clearAllScheduledTaskRemovals = useCallback(() => {
    for (const timeoutId of liveTaskRemovalTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId)
    }
    liveTaskRemovalTimeoutsRef.current.clear()
  }, [])

  useEffect(
    () => () => {
      clearAllScheduledTaskRemovals()
    },
    [clearAllScheduledTaskRemovals],
  )

  return {
    scheduleTaskRemoval,
    clearScheduledTaskRemoval,
    clearAllScheduledTaskRemovals,
  }
}
