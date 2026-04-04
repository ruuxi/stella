import { app } from 'electron'
import type { PiRunnerTarget } from '../../runtime/kernel/lifecycle-targets.js'
import { readConfiguredConvexSiteUrl } from '../../runtime/kernel/convex-urls.js'

const AUTH_CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/

type AuthServiceOptions = {
  authProtocol: string
  isDev: boolean
  projectDir: string
  sessionPartition: string
  runnerTarget: PiRunnerTarget
  onAuthCallback: (url: string) => void
  onSecondInstanceFocus: () => void
}

export class AuthService {
  private pendingAuthCallback: string | null = null
  private pendingConvexUrl: string | null = null
  private pendingConvexSiteUrl: string | null = null
  private hostAuthAuthenticated = false
  private hostAuthToken: string | null = null

  constructor(private readonly options: AuthServiceOptions) {}

  private getDeepLinkUrl(argv: string[]) {
    const protocol = this.options.authProtocol.toLowerCase()
    return argv.find((arg) => arg.toLowerCase().startsWith(`${protocol}://`)) || null
  }

  private isTrustedAuthCallbackUrl(value: string) {
    try {
      const parsed = new URL(value)
      if (parsed.protocol.toLowerCase() !== `${this.options.authProtocol.toLowerCase()}:`) {
        return false
      }
      const host = parsed.hostname.trim().toLowerCase()
      if (host !== 'auth') {
        return false
      }
      const normalizedPath = parsed.pathname.replace(/\/+$/g, '') || '/'
      if (normalizedPath !== '/' && normalizedPath !== '/auth' && normalizedPath !== '/callback') {
        return false
      }
      const token = parsed.searchParams.get('ott')
      return Boolean(token && AUTH_CALLBACK_TOKEN_PATTERN.test(token))
    } catch {
      return false
    }
  }

  stopAuthRefreshLoop() {
    this.hostAuthToken = null
    this.options.runnerTarget.getRunner()?.setAuthToken(null)
  }

  registerAuthProtocol() {
    if (this.options.isDev) {
      app.setAsDefaultProtocolClient(this.options.authProtocol, process.execPath, [this.options.projectDir])
      return
    }
    app.setAsDefaultProtocolClient(this.options.authProtocol)
  }

  enforceSingleInstanceLock() {
    const gotSingleInstanceLock = app.requestSingleInstanceLock()
    if (!gotSingleInstanceLock) {
      app.quit()
      return false
    }

    app.on('second-instance', (_event, argv) => {
      const url = this.getDeepLinkUrl(argv)
      if (url) {
        this.handleAuthCallback(url)
      }
      this.options.onSecondInstanceFocus()
    })
    return true
  }

  bindOpenUrlHandler() {
    app.on('open-url', (event, url) => {
      event.preventDefault()
      this.handleAuthCallback(url)
    })
  }

  captureInitialAuthUrl(argv: string[]) {
    const initialAuthUrl = this.getDeepLinkUrl(argv)
    if (initialAuthUrl) {
      this.pendingAuthCallback = initialAuthUrl
    }
  }

  consumePendingAuthCallback() {
    const callback = this.pendingAuthCallback
    this.pendingAuthCallback = null
    return callback
  }

  handleAuthCallback(url: string) {
    if (!url) {
      return
    }
    if (!this.isTrustedAuthCallbackUrl(url)) {
      console.warn('[security] Rejected untrusted auth callback URL.')
      return
    }
    this.pendingAuthCallback = url
    if (app.isReady()) {
      this.options.onAuthCallback(url)
      this.pendingAuthCallback = null
    }
  }

  setHostAuthState(authenticated: boolean, token?: string) {
    this.hostAuthAuthenticated = authenticated
    if (!authenticated) {
      this.stopAuthRefreshLoop()
      return
    }

    const normalizedToken = typeof token === 'string' ? token.trim() : ''
    if (!normalizedToken) {
      if (!this.hostAuthToken) {
        this.options.runnerTarget.getRunner()?.setAuthToken(null)
      }
      return
    }

    this.hostAuthToken = normalizedToken
    this.options.runnerTarget.getRunner()?.setAuthToken(normalizedToken)
  }

  getHostAuthAuthenticated() {
    return this.hostAuthAuthenticated
  }

  configurePiRuntime(config: { convexUrl: string; convexSiteUrl?: string }) {
    this.pendingConvexUrl = config.convexUrl
    this.pendingConvexSiteUrl = readConfiguredConvexSiteUrl(config.convexSiteUrl)
    this.options.runnerTarget.getRunner()?.setConvexUrl(config.convexUrl)
    this.options.runnerTarget.getRunner()?.setConvexSiteUrl(this.getConvexSiteUrl())
    if (this.hostAuthToken) {
      this.options.runnerTarget.getRunner()?.setAuthToken(this.hostAuthToken)
    }
  }

  getPendingConvexUrl() {
    return this.pendingConvexUrl
  }

  getConvexSiteUrl(): string | null {
    return readConfiguredConvexSiteUrl(this.pendingConvexSiteUrl)
  }

  async getAuthToken(): Promise<string | null> {
    return this.hostAuthToken?.trim() || null
  }

  clearPendingAuthCallback() {
    this.pendingAuthCallback = null
  }
}
