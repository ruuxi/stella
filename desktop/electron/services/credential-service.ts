import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import type { CredentialRequestPayload, CredentialResponsePayload } from '../types.js'
import type { WindowManagerTarget } from './lifecycle-targets.js'

export class CredentialService {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: CredentialResponsePayload) => void
      reject: (reason?: Error) => void
      timeout: NodeJS.Timeout
    }
  >()

  constructor(private readonly options: { windowManagerTarget: WindowManagerTarget; getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null }) {}

  async requestCredential(payload: Omit<CredentialRequestPayload, 'requestId'>) {
    const requestId = randomUUID()
    const request: CredentialRequestPayload = { requestId, ...payload }

    const windowManager = this.options.windowManagerTarget.getWindowManager()
    const focused = BrowserWindow.getFocusedWindow()
    const fullWindow = windowManager?.getFullWindow() ?? null
    const targetWindows = focused ? [focused] : fullWindow ? [fullWindow] : BrowserWindow.getAllWindows()
    if (targetWindows.length === 0) {
      throw new Error('No window available to collect credentials.')
    }

    for (const window of targetWindows) {
      window.webContents.send('credential:request', request)
    }
    this.options.getBroadcastToMobile?.()?.('credential:request', request)

    return new Promise<CredentialResponsePayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Credential request timed out.'))
      }, 5 * 60 * 1000)
      this.pending.set(requestId, { resolve, reject, timeout })
    })
  }

  submitCredential(payload: CredentialResponsePayload) {
    const entry = this.pending.get(payload.requestId)
    if (!entry) {
      return { ok: false, error: 'Credential request not found.' }
    }
    clearTimeout(entry.timeout)
    this.pending.delete(payload.requestId)
    entry.resolve(payload)
    return { ok: true }
  }

  cancelCredential(payload: { requestId: string }) {
    const entry = this.pending.get(payload.requestId)
    if (!entry) {
      return { ok: false, error: 'Credential request not found.' }
    }
    clearTimeout(entry.timeout)
    this.pending.delete(payload.requestId)
    entry.reject(new Error('Credential request cancelled.'))
    return { ok: true }
  }

  cancelAll() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout)
      entry.reject(new Error('Credential request cancelled.'))
    }
    this.pending.clear()
  }
}
