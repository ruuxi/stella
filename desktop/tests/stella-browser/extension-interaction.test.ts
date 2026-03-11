import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getActiveTabMock, ensureDebuggerMock } = vi.hoisted(() => ({
  getActiveTabMock: vi.fn(),
  ensureDebuggerMock: vi.fn(),
}))

vi.mock('../../stella-browser/extension/commands/tabs.js', () => ({
  getActiveTab: getActiveTabMock,
}))

vi.mock('../../stella-browser/extension/lib/debugger.js', () => ({
  ensureDebugger: ensureDebuggerMock,
}))

import { handleDrag } from '../../stella-browser/extension/commands/interaction.js'

describe('extension drag handling', () => {
  let sendCommandMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    let evaluationIndex = 0

    getActiveTabMock.mockResolvedValue({ id: 11, url: 'https://example.com' })
    ensureDebuggerMock.mockResolvedValue(undefined)

    sendCommandMock = vi.fn().mockImplementation(async (_target, method) => {
      if (method === 'Runtime.evaluate') {
        evaluationIndex += 1
        if (evaluationIndex === 1) {
          return { result: { value: { x: 10, y: 20 } } }
        }
        return { result: { value: { x: 30, y: 40 } } }
      }
      return {}
    })

    ;(globalThis as any).chrome = {
      debugger: {
        sendCommand: sendCommandMock,
      },
    }
  })

  it('supports selector-based drag by resolving source and target element centers', async () => {
    const response = await handleDrag({
      id: 'drag-1',
      action: 'drag',
      source: '#drag-source',
      target: '#drop-target',
      steps: 2,
    })

    expect(response).toMatchObject({
      success: true,
      data: { dragged: true },
    })

    const mouseEvents = sendCommandMock.mock.calls
      .filter(([, method]) => method === 'Input.dispatchMouseEvent')
      .map(([, , params]) => params)

    expect(mouseEvents).toEqual([
      { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 },
      { type: 'mouseMoved', x: 20, y: 30, button: 'left' },
      { type: 'mouseMoved', x: 30, y: 40, button: 'left' },
      { type: 'mouseReleased', x: 30, y: 40, button: 'left', clickCount: 1 },
    ])
  })
})
