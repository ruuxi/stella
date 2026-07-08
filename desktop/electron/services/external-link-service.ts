import { BrowserWindow, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const MOBILE_BRIDGE_PROTOCOL = 'stella-mobile-bridge:'
const MOBILE_BRIDGE_SENDER_URL = 'stella-mobile-bridge://mobile'
const MAX_EXTERNAL_URL_LENGTH = 4096
const EXTERNAL_OPEN_MIN_INTERVAL_MS = 300
const EXTERNAL_OPEN_WINDOW_MS = 15_000
const EXTERNAL_OPEN_MAX_PER_WINDOW = 20

export class ExternalLinkService {
  private readonly externalOpenRateBySender = new Map<
    number,
    { windowStartMs: number; count: number; lastOpenedAtMs: number }
  >()

  /** When set (dev: Vite on LAN), renderer at this origin may use privileged IPC. */
  private trustedDevOrigin: string | null = null
  private trustedFileRendererRoot: string | null = null

  /** Dev-only: allow privileged IPC when sender URL is missing (Electron edge cases). */
  private isDevBuild = false

  /**
   * Optional interceptor for canvas-share links. When it returns true the URL
   * was recognized + handled (rendered as a native canvas), so it should NOT
   * be forwarded to the system browser.
   */
  private canvasShareHandler: ((url: string) => boolean) | null = null

  setCanvasShareHandler(handler: ((url: string) => boolean) | null) {
    this.canvasShareHandler = handler
  }

  private tryHandleCanvasShare(url: string) {
    try {
      return this.canvasShareHandler?.(url) ?? false
    } catch {
      return false
    }
  }

  private parseUrl(value: string) {
    try {
      return new URL(value)
    } catch {
      return null
    }
  }

  private isTrustedFileRendererUrl(parsed: URL) {
    if (parsed.protocol !== 'file:' || !this.trustedFileRendererRoot) {
      return false
    }
    try {
      const filePath = path.resolve(fileURLToPath(parsed))
      const relativePath = path.relative(this.trustedFileRendererRoot, filePath)
      return (
        relativePath === '' ||
        (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
      )
    } catch {
      return false
    }
  }

  isAppUrl(url: string) {
    const parsed = this.parseUrl(url)
    if (!parsed) return false
    if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return true
    if (this.trustedDevOrigin && parsed.origin === this.trustedDevOrigin) {
      return true
    }
    if (this.isTrustedFileRendererUrl(parsed)) {
      return true
    }
    return false
  }

  /**
   * Call in dev with the same base URL Vite uses (from .vite-dev-url), including LAN hosts.
   */
  trustDevServerBaseUrl(baseUrl: string) {
    const trimmed = baseUrl.trim()
    if (!trimmed) return
    const parsed = this.parseUrl(trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed)
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return
    this.trustedDevOrigin = parsed.origin
  }

  trustFileRendererRoot(rootPath: string) {
    const trimmed = rootPath.trim()
    if (!trimmed) return
    this.trustedFileRendererRoot = path.resolve(trimmed)
  }

  setDevBuild(isDev: boolean) {
    this.isDevBuild = isDev
  }

  isTrustedRendererUrl(url: string) {
    const parsed = this.parseUrl(url)
    if (!parsed) return false
    if (parsed.protocol === MOBILE_BRIDGE_PROTOCOL && parsed.href === MOBILE_BRIDGE_SENDER_URL) {
      return true
    }
    if (this.trustedDevOrigin && parsed.origin === this.trustedDevOrigin) {
      return true
    }
    if (this.isTrustedFileRendererUrl(parsed)) {
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
    if (this.isDevBuild && !senderUrl.trim()) {
      console.warn(
        `[security] Dev: privileged IPC ${channel} with empty sender URL (allowing)`,
      )
      return true
    }
    console.warn(`[security] Blocked untrusted IPC call to ${channel} from ${senderUrl}`)
    return false
  }

  setupExternalLinkHandlers(window: BrowserWindow) {
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!this.isAppUrl(url) && !this.tryHandleCanvasShare(url)) {
        this.openSafeExternalUrl(url)
      }
      return { action: 'deny' }
    })

    window.webContents.on('will-navigate', (event, url) => {
      if (!this.isAppUrl(url)) {
        event.preventDefault()
        if (!this.tryHandleCanvasShare(url)) {
          this.openSafeExternalUrl(url)
        }
      }
    })
  }
}
