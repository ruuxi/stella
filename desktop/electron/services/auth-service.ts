import { app, session } from 'electron'

const AUTH_CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/
const TOKEN_REFRESH_INTERVAL_MS = 60 * 1000

type PiRunnerAuthTarget = {
  setAuthToken: (token: string | null) => void
  setConvexUrl: (url: string) => void
}

type AuthServiceOptions = {
  authProtocol: string
  isDev: boolean
  projectDir: string
  sessionPartition: string
  getRunner: () => PiRunnerAuthTarget | null
  onAuthCallback: (url: string) => void
  onSecondInstanceFocus: () => void
}

const deriveConvexSiteUrl = (convexUrl: string | null, explicitSiteUrl?: string | null) => {
  const explicit = explicitSiteUrl?.trim()
  if (explicit) {
    return explicit
  }
  const source = convexUrl?.trim()
  if (!source) {
    return null
  }
  if (source.includes('.convex.site')) {
    return source
  }
  if (source.includes('.convex.cloud')) {
    return source.replace('.convex.cloud', '.convex.site')
  }
  return null
}

export class AuthService {
  private pendingAuthCallback: string | null = null
  private pendingConvexUrl: string | null = null
  private pendingConvexSiteUrl: string | null = null
  private hostAuthAuthenticated = false
  private authRefreshTimer: NodeJS.Timeout | null = null

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

  private async parseTokenResponse(response: Response): Promise<string | null> {
    try {
      const payload = (await response.json()) as unknown
      if (!payload || typeof payload !== 'object') {
        return null
      }
      const record = payload as { token?: unknown; data?: { token?: unknown } }
      const nestedToken = record.data?.token
      if (typeof nestedToken === 'string' && nestedToken.trim()) {
        return nestedToken
      }
      if (typeof record.token === 'string' && record.token.trim()) {
        return record.token
      }
      return null
    } catch {
      return null
    }
  }

  private async fetchRunnerAuthToken(): Promise<string | null> {
    const convexSiteUrl = deriveConvexSiteUrl(this.pendingConvexUrl, this.pendingConvexSiteUrl)
    if (!convexSiteUrl) {
      return null
    }

    const tokenUrl = new URL('/api/auth/convex/token', convexSiteUrl).toString()
    try {
      const appSession = session.fromPartition(this.options.sessionPartition)
      const cookies = await appSession.cookies.get({ url: tokenUrl })
      const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      if (!cookieHeader) {
        return null
      }

      const response = await fetch(tokenUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Cookie: cookieHeader,
        },
      })
      if (!response.ok) {
        if (response.status !== 401 && response.status !== 403) {
          console.warn(`[auth] Failed to refresh runner token: ${response.status}`)
        }
        return null
      }
      return await this.parseTokenResponse(response)
    } catch (error) {
      console.warn('[auth] Failed to fetch runner token from session', error)
      return null
    }
  }

  private async refreshRunnerAuthToken() {
    if (!this.hostAuthAuthenticated) {
      this.options.getRunner()?.setAuthToken(null)
      return
    }
    const token = await this.fetchRunnerAuthToken()
    if (token) {
      this.options.getRunner()?.setAuthToken(token)
    }
  }

  private startAuthRefreshLoop() {
    if (this.authRefreshTimer) {
      return
    }
    void this.refreshRunnerAuthToken()
    this.authRefreshTimer = setInterval(() => {
      void this.refreshRunnerAuthToken()
    }, TOKEN_REFRESH_INTERVAL_MS)
  }

  stopAuthRefreshLoop() {
    if (this.authRefreshTimer) {
      clearInterval(this.authRefreshTimer)
      this.authRefreshTimer = null
    }
    this.options.getRunner()?.setAuthToken(null)
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

    if (token) {
      this.options.getRunner()?.setAuthToken(token)
    }
    this.startAuthRefreshLoop()
  }

  getHostAuthAuthenticated() {
    return this.hostAuthAuthenticated
  }

  configurePiRuntime(config: { convexUrl: string; convexSiteUrl?: string }) {
    this.pendingConvexUrl = config.convexUrl
    this.pendingConvexSiteUrl = config.convexSiteUrl ?? null
    this.options.getRunner()?.setConvexUrl(config.convexUrl)

    if (this.hostAuthAuthenticated) {
      void this.refreshRunnerAuthToken()
    }
  }

  getPendingConvexUrl() {
    return this.pendingConvexUrl
  }

  getConvexSiteUrl(): string | null {
    return deriveConvexSiteUrl(this.pendingConvexUrl, this.pendingConvexSiteUrl)
  }

  async getAuthToken(): Promise<string | null> {
    if (!this.hostAuthAuthenticated) return null
    return this.fetchRunnerAuthToken()
  }

  clearPendingAuthCallback() {
    this.pendingAuthCallback = null
  }
}
