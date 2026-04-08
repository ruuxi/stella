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
  private hostHasConnectedAccount = false
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
    const runner = this.options.runnerTarget.getRunner()
    this.hostHasConnectedAccount = false
    runner?.setHasConnectedAccount(false)
    this.hostAuthToken = null
    runner?.setAuthToken(null)
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

  setHostAuthState(
    authenticated: boolean,
    token?: string,
    hasConnectedAccount?: boolean,
  ) {
    const runner = this.options.runnerTarget.getRunner()
    const previousAuthToken = this.hostAuthToken
    const previousHasConnectedAccount = this.hostHasConnectedAccount
    this.hostAuthAuthenticated = authenticated
    this.hostHasConnectedAccount = authenticated
      ? (hasConnectedAccount ?? this.hostHasConnectedAccount)
      : false
    const normalizedToken = typeof token === 'string' ? token.trim() : ''

    if (!authenticated) {
      this.stopAuthRefreshLoop()
      return
    }

    if (normalizedToken) {
      this.hostAuthToken = normalizedToken
      if (normalizedToken !== previousAuthToken) {
        runner?.setAuthToken(normalizedToken)
      }
    } else if (!this.hostAuthToken) {
      runner?.setAuthToken(null)
    }

    if (this.hostHasConnectedAccount !== previousHasConnectedAccount) {
      runner?.setHasConnectedAccount(this.hostHasConnectedAccount)
    }
  }

  getHostAuthAuthenticated() {
    return this.hostAuthAuthenticated
  }

  getHostHasConnectedAccount() {
    return this.hostHasConnectedAccount
  }

  configurePiRuntime(config: { convexUrl: string; convexSiteUrl?: string }) {
    this.pendingConvexUrl = config.convexUrl
    this.pendingConvexSiteUrl = readConfiguredConvexSiteUrl(config.convexSiteUrl)
    const runner = this.options.runnerTarget.getRunner()
    runner?.setConvexUrl(config.convexUrl)
    runner?.setConvexSiteUrl(this.getConvexSiteUrl())
    if (this.hostAuthToken) {
      runner?.setAuthToken(this.hostAuthToken)
    }
    runner?.setHasConnectedAccount(this.hostHasConnectedAccount)
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
