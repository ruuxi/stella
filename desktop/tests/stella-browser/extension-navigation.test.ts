import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const {
  getActiveTabMock,
  ensureDebuggerMock,
  onCdpEventMock,
  offCdpEventMock,
} = vi.hoisted(() => ({
  getActiveTabMock: vi.fn(),
  ensureDebuggerMock: vi.fn(),
  onCdpEventMock: vi.fn(),
  offCdpEventMock: vi.fn(),
}))

vi.mock('../../stella-browser/extension/commands/tabs.js', () => ({
  getActiveTab: getActiveTabMock,
}))

vi.mock('../../stella-browser/extension/lib/debugger.js', () => ({
  ensureDebugger: ensureDebuggerMock,
  onCdpEvent: onCdpEventMock,
  offCdpEvent: offCdpEventMock,
}))

import { handleNavigate } from '../../stella-browser/extension/commands/navigation.js'

describe('extension navigation waits', () => {
  let listeners: Map<string, (params?: Record<string, unknown>) => void>
  let sendCommandMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listeners = new Map()
    sendCommandMock = vi.fn().mockResolvedValue({})

    getActiveTabMock.mockResolvedValue({ id: 7, url: 'about:blank', title: 'Blank' })
    ensureDebuggerMock.mockResolvedValue(undefined)
    onCdpEventMock.mockImplementation((tabId, method, callback) => {
      listeners.set(`${tabId}:${method}`, callback)
    })
    offCdpEventMock.mockImplementation((tabId, method) => {
      listeners.delete(`${tabId}:${method}`)
    })

    ;(globalThis as any).chrome = {
      tabs: {
        update: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: 'https://example.com',
          title: 'Example',
        }),
        goBack: vi.fn().mockResolvedValue(undefined),
        goForward: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      debugger: {
        sendCommand: sendCommandMock,
      },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for domcontentloaded via CDP page events', async () => {
    const responsePromise = handleNavigate({
      id: 'nav-1',
      action: 'navigate',
      url: 'https://example.com',
      waitUntil: 'domcontentloaded',
    })

    await vi.waitFor(() => {
      expect(onCdpEventMock).toHaveBeenCalledWith(7, 'Page.domContentEventFired', expect.any(Function))
    })

    listeners.get('7:Page.domContentEventFired')?.({})

    await expect(responsePromise).resolves.toMatchObject({
      success: true,
      data: {
        url: 'https://example.com',
        title: 'Example',
      },
    })
    expect(sendCommandMock).toHaveBeenCalledWith({ tabId: 7 }, 'Page.enable')
  })

  it('waits for network idle after the navigation request settles', async () => {
    vi.useFakeTimers()

    const responsePromise = handleNavigate({
      id: 'nav-2',
      action: 'navigate',
      url: 'https://example.com',
      waitUntil: 'networkidle',
    })

    await vi.waitFor(() => {
      expect(onCdpEventMock).toHaveBeenCalledWith(7, 'Network.requestWillBeSent', expect.any(Function))
      expect(onCdpEventMock).toHaveBeenCalledWith(7, 'Network.loadingFinished', expect.any(Function))
      expect(onCdpEventMock).toHaveBeenCalledWith(7, 'Page.loadEventFired', expect.any(Function))
    })

    listeners.get('7:Network.requestWillBeSent')?.({
      requestId: 'doc-1',
      type: 'Document',
    })
    listeners.get('7:Page.loadEventFired')?.({})
    listeners.get('7:Network.loadingFinished')?.({
      requestId: 'doc-1',
    })

    await vi.advanceTimersByTimeAsync(500)

    await expect(responsePromise).resolves.toMatchObject({
      success: true,
    })
    expect(sendCommandMock).toHaveBeenCalledWith({ tabId: 7 }, 'Network.enable')
  })
})
