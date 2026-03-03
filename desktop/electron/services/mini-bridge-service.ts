import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type {
  MiniBridgeRequest,
  MiniBridgeResponse,
  MiniBridgeResponseEnvelope,
  MiniBridgeUpdate,
} from '../mini-bridge.js'

const MINI_BRIDGE_REQUEST_TIMEOUT_MS = 15_000

export class MiniBridgeService {
  private readonly pendingMiniBridgeRequests = new Map<
    string,
    {
      resolve: (value: MiniBridgeResponse) => void
      reject: (reason?: Error) => void
      timeout: NodeJS.Timeout
    }
  >()
  private readonly queuedMiniBridgeRequests = new Map<string, MiniBridgeRequest>()
  private fullMiniBridgeReady = false

  private resolveMiniBridgeRequest(requestId: string, response: MiniBridgeResponse) {
    const pending = this.pendingMiniBridgeRequests.get(requestId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timeout)
    this.pendingMiniBridgeRequests.delete(requestId)
    this.queuedMiniBridgeRequests.delete(requestId)
    pending.resolve(response)
  }

  private rejectMiniBridgeRequest(requestId: string, error: Error) {
    const pending = this.pendingMiniBridgeRequests.get(requestId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timeout)
    this.pendingMiniBridgeRequests.delete(requestId)
    this.queuedMiniBridgeRequests.delete(requestId)
    pending.reject(error)
  }

  rejectAllMiniBridgeRequests(reason: string) {
    for (const [requestId, pending] of this.pendingMiniBridgeRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(reason))
      this.pendingMiniBridgeRequests.delete(requestId)
    }
    this.queuedMiniBridgeRequests.clear()
  }

  onFullWindowDidStartLoading() {
    this.fullMiniBridgeReady = false
  }

  onFullWindowUnavailable(reason: string) {
    this.fullMiniBridgeReady = false
    this.rejectAllMiniBridgeRequests(reason)
  }

  private flushQueuedMiniBridgeRequests(fullWindow: BrowserWindow | null) {
    if (!this.fullMiniBridgeReady || !fullWindow || fullWindow.isDestroyed()) {
      return
    }
    if (fullWindow.webContents.isLoadingMainFrame()) {
      return
    }

    for (const [requestId, request] of this.queuedMiniBridgeRequests) {
      if (!this.pendingMiniBridgeRequests.has(requestId)) {
        this.queuedMiniBridgeRequests.delete(requestId)
        continue
      }
      fullWindow.webContents.send('miniBridge:request', { requestId, request })
      this.queuedMiniBridgeRequests.delete(requestId)
    }
  }

  async requestFromMini(
    senderWindow: BrowserWindow | null,
    miniWindow: BrowserWindow | null,
    fullWindow: BrowserWindow | null,
    request: MiniBridgeRequest,
  ) {
    if (!senderWindow || senderWindow !== miniWindow) {
      throw new Error('miniBridge requests are only allowed from mini window')
    }

    const fullTarget = fullWindow
    if (!fullTarget || fullTarget.isDestroyed()) {
      throw new Error('Full window is unavailable')
    }

    const requestId = randomUUID()
    return await new Promise<MiniBridgeResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectMiniBridgeRequest(requestId, new Error('miniBridge request timed out'))
      }, MINI_BRIDGE_REQUEST_TIMEOUT_MS)

      this.pendingMiniBridgeRequests.set(requestId, { resolve, reject, timeout })
      if (fullTarget.isDestroyed()) {
        this.rejectMiniBridgeRequest(requestId, new Error('Full window is unavailable'))
        return
      }

      this.queuedMiniBridgeRequests.set(requestId, request)
      this.flushQueuedMiniBridgeRequests(fullTarget)
    })
  }

  handleReadySignal(senderWindow: BrowserWindow | null, fullWindow: BrowserWindow | null) {
    if (!senderWindow || senderWindow !== fullWindow) {
      return
    }

    this.fullMiniBridgeReady = true
    this.flushQueuedMiniBridgeRequests(fullWindow)
  }

  handleResponseSignal(
    senderWindow: BrowserWindow | null,
    fullWindow: BrowserWindow | null,
    envelope: MiniBridgeResponseEnvelope,
  ) {
    if (!senderWindow || senderWindow !== fullWindow) {
      return
    }

    const requestId = typeof envelope?.requestId === 'string' ? envelope.requestId : null
    if (!requestId) {
      return
    }
    this.resolveMiniBridgeRequest(requestId, envelope.response)
  }

  handleUpdateSignal(
    senderWindow: BrowserWindow | null,
    fullWindow: BrowserWindow | null,
    miniWindow: BrowserWindow | null,
    update: MiniBridgeUpdate,
  ) {
    if (!senderWindow || senderWindow !== fullWindow) {
      return
    }
    if (!miniWindow || miniWindow.isDestroyed()) {
      return
    }
    miniWindow.webContents.send('miniBridge:update', update)
  }
}
