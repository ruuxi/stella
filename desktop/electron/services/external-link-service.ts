import { BrowserWindow, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const MAX_EXTERNAL_URL_LENGTH = 4096
const EXTERNAL_OPEN_MIN_INTERVAL_MS = 300
const EXTERNAL_OPEN_WINDOW_MS = 15_000
const EXTERNAL_OPEN_MAX_PER_WINDOW = 20

export class ExternalLinkService {
  private readonly externalOpenRateBySender = new Map<
    number,
    { windowStartMs: number; count: number; lastOpenedAtMs: number }
  >()

  private parseUrl(value: string) {
    try {
      return new URL(value)
    } catch {
      return null
    }
  }

  private isLoopbackHost(hostname: string) {
    return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase())
  }

  isAppUrl(url: string) {
    const parsed = this.parseUrl(url)
    if (!parsed) return false
    if (parsed.protocol === 'file:') return true
    if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return true
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && this.isLoopbackHost(parsed.hostname)) {
      return true
    }
    return false
  }

  isTrustedRendererUrl(url: string) {
    const parsed = this.parseUrl(url)
    if (!parsed) return false
    if (parsed.protocol === 'file:') return true
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && this.isLoopbackHost(parsed.hostname)) {
      return true
    }
    return false
  }

  normalizeExternalHttpUrl(value: unknown) {
    if (typeof value !== 'string') {
      return null
    }
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > MAX_EXTERNAL_URL_LENGTH) {
      return null
    }
    const parsed = this.parseUrl(trimmed)
    if (!parsed) {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return trimmed
  }

  openSafeExternalUrl(value: unknown) {
    const safeUrl = this.normalizeExternalHttpUrl(value)
    if (!safeUrl) {
      return false
    }
    void shell.openExternal(safeUrl)
    return true
  }

  consumeExternalOpenBudget(senderId: number) {
    const now = Date.now()
    const existing = this.externalOpenRateBySender.get(senderId)
    if (!existing || now - existing.windowStartMs > EXTERNAL_OPEN_WINDOW_MS) {
      this.externalOpenRateBySender.set(senderId, {
        windowStartMs: now,
        count: 1,
        lastOpenedAtMs: now,
      })
      return true
    }
    if (now - existing.lastOpenedAtMs < EXTERNAL_OPEN_MIN_INTERVAL_MS) {
      return false
    }
    if (existing.count >= EXTERNAL_OPEN_MAX_PER_WINDOW) {
      return false
    }
    existing.count += 1
    existing.lastOpenedAtMs = now
    return true
  }

  clearSenderRateLimits() {
    this.externalOpenRateBySender.clear()
  }

  getSenderUrl(event: IpcMainEvent | IpcMainInvokeEvent) {
    return event.senderFrame?.url || event.sender.getURL() || ''
  }

  assertPrivilegedSender(event: IpcMainEvent | IpcMainInvokeEvent, channel: string) {
    const senderUrl = this.getSenderUrl(event)
    if (this.isTrustedRendererUrl(senderUrl)) {
      return true
    }
    console.warn(`[security] Blocked privileged IPC "${channel}" from untrusted sender: ${senderUrl || '(unknown)'}`)
    return false
  }

  setupExternalLinkHandlers(window: BrowserWindow) {
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!this.isAppUrl(url)) {
        if (!this.openSafeExternalUrl(url)) {
          console.warn(`[security] Blocked unsafe external navigation request: ${url}`)
        }
      }
      return { action: 'deny' }
    })

    window.webContents.on('will-navigate', (event, url) => {
      if (!this.isAppUrl(url)) {
        event.preventDefault()
        if (!this.openSafeExternalUrl(url)) {
          console.warn(`[security] Blocked unsafe external in-app navigation: ${url}`)
        }
      }
    })
  }
}
