import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  connectMock,
  disconnectMock,
  isConnectedMock,
  onCommandMock,
  onStatusMock,
  closeAgentWindowMock,
  stubHandlerMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  isConnectedMock: vi.fn(() => true),
  onCommandMock: vi.fn(),
  onStatusMock: vi.fn(),
  closeAgentWindowMock: vi.fn(),
  stubHandlerMock: vi.fn(async (command) => ({
    id: command.id ?? 'stub',
    success: true,
    data: {},
  })),
}))

vi.mock('../../stella-browser/extension/lib/connection.js', () => ({
  connect: connectMock,
  disconnect: disconnectMock,
  isConnected: isConnectedMock,
  onCommand: onCommandMock,
  onStatus: onStatusMock,
}))

vi.mock('../../stella-browser/extension/commands/tabs.js', () => ({
  handleTabNew: stubHandlerMock,
  handleTabList: stubHandlerMock,
  handleTabSwitch: stubHandlerMock,
  handleTabClose: stubHandlerMock,
  closeAgentWindow: closeAgentWindowMock,
}))

vi.mock('../../stella-browser/extension/commands/navigation.js', () => ({
  handleNavigate: stubHandlerMock,
  handleBack: stubHandlerMock,
  handleForward: stubHandlerMock,
  handleReload: stubHandlerMock,
  handleUrl: stubHandlerMock,
  handleTitle: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/interaction.js', () => ({
  handleClick: stubHandlerMock,
  handleFill: stubHandlerMock,
  handleType: stubHandlerMock,
  handleHover: stubHandlerMock,
  handleSelect: stubHandlerMock,
  handlePress: stubHandlerMock,
  handleScroll: stubHandlerMock,
  handleClear: stubHandlerMock,
  handleCheck: stubHandlerMock,
  handleUncheck: stubHandlerMock,
  handleFocus: stubHandlerMock,
  handleDblclick: stubHandlerMock,
  handleWait: stubHandlerMock,
  handleClipboard: stubHandlerMock,
  handleMouseMove: stubHandlerMock,
  handleMouseDown: stubHandlerMock,
  handleMouseUp: stubHandlerMock,
  handleDrag: stubHandlerMock,
  handleKeyDown: stubHandlerMock,
  handleKeyUp: stubHandlerMock,
  handleInsertText: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/capture.js', () => ({
  handleScreenshot: stubHandlerMock,
  handleSnapshot: stubHandlerMock,
  handleContent: stubHandlerMock,
  handleEvaluate: stubHandlerMock,
  handleGetText: stubHandlerMock,
  handleGetAttribute: stubHandlerMock,
  handlePdf: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/cookies.js', () => ({
  handleCookiesGet: stubHandlerMock,
  handleCookiesSet: stubHandlerMock,
  handleCookiesClear: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/queries.js', () => ({
  handleInnerText: stubHandlerMock,
  handleInnerHtml: stubHandlerMock,
  handleInputValue: stubHandlerMock,
  handleBoundingBox: stubHandlerMock,
  handleWaitForUrl: stubHandlerMock,
  handleScrollIntoView: stubHandlerMock,
  handleIsVisible: stubHandlerMock,
  handleIsEnabled: stubHandlerMock,
  handleIsChecked: stubHandlerMock,
  handleCount: stubHandlerMock,
  handleStyles: stubHandlerMock,
  handleBringToFront: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/network.js', () => ({
  handleRequests: stubHandlerMock,
  handleResponseBody: stubHandlerMock,
  handleRoute: stubHandlerMock,
  handleUnroute: stubHandlerMock,
  handleHarStart: stubHandlerMock,
  handleHarStop: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/downloads.js', () => ({
  handleDownload: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/chain.js', () => ({
  handleChain: stubHandlerMock,
}))

vi.mock('../../stella-browser/extension/commands/site-mods.js', () => ({
  handleSiteModSet: stubHandlerMock,
  handleSiteModList: stubHandlerMock,
  handleSiteModRemove: stubHandlerMock,
  handleSiteModToggle: stubHandlerMock,
}))

describe('extension background reconnect handling', () => {
  let statusListener: ((connected: boolean) => void) | undefined
  let startupListener: (() => void | Promise<void>) | undefined
  let installedListener: (() => void | Promise<void>) | undefined

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()

    statusListener = undefined
    startupListener = undefined
    installedListener = undefined
    onCommandMock.mockImplementation(() => {})
    onStatusMock.mockImplementation((callback) => {
      statusListener = callback
    })

    ;(globalThis as any).chrome = {
      runtime: {
        onConnect: {
          addListener: vi.fn(),
        },
        onStartup: {
          addListener: vi.fn((callback) => {
            startupListener = callback
          }),
        },
        onInstalled: {
          addListener: vi.fn((callback) => {
            installedListener = callback
          }),
        },
        onMessage: {
          addListener: vi.fn(),
        },
        getContexts: vi.fn().mockResolvedValue([]),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      },
      offscreen: {
        createDocument: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ port: 9224, token: '' }),
        },
      },
    }

    await import('../../stella-browser/extension/background.js')
  })

  it('keeps the automation window open when the extension reconnects', async () => {
    expect(statusListener).toBeTypeOf('function')

    await statusListener?.(false)

    expect(closeAgentWindowMock).not.toHaveBeenCalled()
  })

  it('registers startup hooks to reconnect after browser relaunch', async () => {
    expect((globalThis as any).chrome.runtime.onStartup.addListener).toHaveBeenCalledTimes(1)
    expect((globalThis as any).chrome.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1)
  })

  it('does not create duplicate offscreen documents during repeated initialization', async () => {
    expect((globalThis as any).chrome.offscreen.createDocument).toHaveBeenCalledTimes(1)

    await startupListener?.()
    await installedListener?.()

    expect((globalThis as any).chrome.offscreen.createDocument).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(connectMock).toHaveBeenCalledTimes(3)
    })
  })
})
