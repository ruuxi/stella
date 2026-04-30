import { useEffect, useMemo, useState } from 'react'
import {
  extractTasksFromEvents,
  getFooterTasksFromTasks,
  mergeFooterTasks,
  TASK_COMPLETION_INDICATOR_MS,
  type EventRecord,
  type TaskItem,
} from '@/app/chat/lib/event-transforms'

type UseFooterTasksArgs = {
  events: EventRecord[]
  liveTasks?: TaskItem[]
  appSessionStartedAtMs?: number | null
}

export function useFooterTasks({
  events,
  liveTasks,
  appSessionStartedAtMs,
}: UseFooterTasksArgs): TaskItem[] {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const latestEventTimestamp = events.at(-1)?.timestamp ?? 0

  useEffect(() => {
    setNowMs(Date.now())
  }, [appSessionStartedAtMs, latestEventTimestamp])

  const extractedTasks = useMemo(
    () => extractTasksFromEvents(events, { appSessionStartedAtMs }),
    [appSessionStartedAtMs, events],
  )

  useEffect(() => {
    const nextExpiryAt = extractedTasks.reduce<number | null>(
      (current, task) => {
        if (
          task.status !== 'completed' ||
          typeof task.completedAtMs !== 'number'
        ) {
          return current
        }
        const expiryAt = task.completedAtMs + TASK_COMPLETION_INDICATOR_MS
        if (expiryAt <= nowMs) {
          return current
        }
        return current === null ? expiryAt : Math.min(current, expiryAt)
      },
      null,
    )

    if (nextExpiryAt === null) {
      return
    }

    const delayMs = Math.max(0, nextExpiryAt - Date.now())
    const timeoutId = window.setTimeout(() => {
      setNowMs(Date.now())
    }, delayMs)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [extractedTasks, nowMs])

  const persistedFooterTasks = useMemo(
    () => getFooterTasksFromTasks(extractedTasks, { nowMs }),
    [extractedTasks, nowMs],
  )

  const footerTasks = useMemo(
    () => mergeFooterTasks(persistedFooterTasks, liveTasks),
    [liveTasks, persistedFooterTasks],
  )

  useEffect(() => {
    console.debug('[stella:working-indicator:footer-tasks]', {
      persisted: persistedFooterTasks.map((task) => ({
        id: task.id,
        description: task.description,
        status: task.status,
        statusText: task.statusText,
      })),
      live: (liveTasks ?? []).map((task) => ({
        id: task.id,
        description: task.description,
        status: task.status,
        statusText: task.statusText,
      })),
      merged: footerTasks.map((task) => ({
        id: task.id,
        description: task.description,
        status: task.status,
        statusText: task.statusText,
      })),
    })
  }, [footerTasks, liveTasks, persistedFooterTasks])

  return footerTasks
}
