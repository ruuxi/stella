import { describe, expect, it, vi } from 'vitest'
import { executeCommand } from '../../stella-browser/src/actions.js'
import type { BrowserManager } from '../../stella-browser/src/browser.js'
import type { ChainCommand } from '../../stella-browser/src/types.js'

describe('stella-browser desktop actions', () => {
  it('executes chain commands instead of treating them as unknown actions', async () => {
    const browser = {
      getPage: () => ({
        waitForSelector: vi.fn(),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        waitForLoadState: vi.fn(),
      }),
      getLocator: vi.fn(() => ({
        waitFor: vi.fn().mockResolvedValue(undefined),
      })),
    } as unknown as BrowserManager

    const command: ChainCommand = {
      id: 'chain-1',
      action: 'chain',
      steps: [
        {
          action: 'wait',
          timeout: 1,
        },
      ],
      delay: { min: 0, max: 0 },
    }

    const response = await executeCommand(command, browser)

    expect(response.success).toBe(true)
    if (!response.success) {
      throw new Error(response.error)
    }
    expect(response.data).toEqual(
      expect.objectContaining({
        completed: 1,
        total: 1,
        results: [
          expect.objectContaining({
            action: 'wait',
            success: true,
          }),
        ],
      }),
    )
  })
})
