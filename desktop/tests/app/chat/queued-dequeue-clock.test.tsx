// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useQueuedDequeueClock } from '@/features/chat/hooks/use-queued-dequeue-clock'

type ProbeProps = {
  conversationId: string
  persistedTimestamps: number[]
  optimisticTimestamps?: number[]
  api: { current: ((wallClockMs: number) => number) | null }
}

function Probe({
  conversationId,
  persistedTimestamps,
  optimisticTimestamps = [],
  api,
}: ProbeProps) {
  api.current = useQueuedDequeueClock({
    conversationId,
    persistedMessages: persistedTimestamps.map((timestamp) => ({ timestamp })),
    optimisticEvents: optimisticTimestamps.map((timestamp) => ({ timestamp })),
  })
  return null
}

describe('useQueuedDequeueClock', () => {
  let container: HTMLDivElement
  let root: Root
  const api: ProbeProps['api'] = { current: null }

  beforeEach(() => {
    const reactActGlobal = globalThis as {
      IS_REACT_ACT_ENVIRONMENT?: boolean
    }
    reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true
    api.current = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('issues separate same-millisecond drains in strict timeline order', async () => {
    await act(async () => {
      root.render(
        <Probe
          conversationId="conversation-a"
          persistedTimestamps={[499]}
          api={api}
        />,
      )
    })

    expect(api.current!(500)).toBe(500)
    expect(api.current!(500)).toBe(502)
  })

  it('resets on conversation switch and remount without falling below the transcript', async () => {
    await act(async () => {
      root.render(
        <Probe
          conversationId="conversation-a"
          persistedTimestamps={[]}
          api={api}
        />,
      )
    })
    expect(api.current!(1_000)).toBe(1_000)

    await act(async () => {
      root.render(
        <Probe
          conversationId="conversation-b"
          persistedTimestamps={[20]}
          api={api}
        />,
      )
    })
    expect(api.current!(10)).toBe(21)

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(
        <Probe
          conversationId="conversation-c"
          persistedTimestamps={[700]}
          api={api}
        />,
      )
    })
    expect(api.current!(10)).toBe(701)
  })
})
