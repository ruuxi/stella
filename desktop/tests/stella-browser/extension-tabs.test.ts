import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('extension tabs self-heal', () => {
  beforeEach(() => {
    vi.resetModules()

    ;(globalThis as any).chrome = {
      windows: {
        get: vi.fn().mockResolvedValue({ id: 3 }),
        create: vi.fn().mockResolvedValue({ id: 3 }),
      },
      tabs: {
        query: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 7, windowId: 3, active: true, groupId: -1, url: 'about:blank', title: 'Blank' },
          ])
          .mockResolvedValueOnce([
            { id: 7, windowId: 3, active: true, groupId: -1, url: 'about:blank', title: 'Blank' },
          ])
          .mockResolvedValueOnce([
            { id: 7, windowId: 3, active: true, groupId: 11, url: 'about:blank', title: 'Blank' },
          ]),
        group: vi.fn().mockResolvedValue(11),
      },
      tabGroups: {
        get: vi.fn().mockRejectedValue(new Error('missing')),
        update: vi.fn().mockResolvedValue(undefined),
      },
    }
  })

  it('recreates the Stella group when the agent window exists but the group is missing', async () => {
    const { getActiveTab } = await import('../../stella-browser/extension/commands/tabs.js')

    const tab = await getActiveTab()

    expect(tab.id).toBe(7)
    expect((globalThis as any).chrome.tabs.group).toHaveBeenCalledWith({
      tabIds: [7],
      createProperties: { windowId: 3 },
    })
    expect((globalThis as any).chrome.tabGroups.update).toHaveBeenCalledWith(11, {
      title: 'Stella',
      color: 'purple',
    })
  })
})
