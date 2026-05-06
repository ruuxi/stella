import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { PiRunnerTarget } from '../../../runtime/kernel/lifecycle-targets.js'
import { readConfiguredConvexSiteUrl } from '../../../runtime/kernel/convex-urls.js'
import {
  protectValue,
  unprotectValue,
} from '../../../runtime/kernel/shared/protected-storage.js'
import type {
  HostRuntimeAuthRefreshResult,
  RuntimeAuthRefreshSource,
} from '../../../runtime/protocol/index.js'

const AUTH_CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/
const RUNTIME_AUTH_REFRESH_TIMEOUT_MS = 12_000
const AUTH_STORAGE_SCOPE = 'desktop-better-auth-storage'
const AUTH_STORAGE_FILE = 'better-auth-storage.json'
const PLAINTEXT_PREFIX = 'stella-main-plaintext:v1:'

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
  private authStorageCache: Record<string, string | null> | null = null
  private runtimeAuthRefreshPromise: Promise<HostRuntimeAuthRefreshResult> | null = null
  private runtimeAuthRefreshResolve:
    | ((result: HostRuntimeAuthRefreshResult) => void)
    | null = null
  private runtimeAuthRefreshRequestId: string | null = null
  private runtimeAuthRefreshTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: AuthServiceOptions) {}

  private getAuthStoragePath() {
    return path.join(app.getPath('userData'), AUTH_STORAGE_FILE)
  }

  private encodeAuthStorageValue(value: string): string {
    try {
      return protectValue(AUTH_STORAGE_SCOPE, value)
    } catch (error) {
      console.warn(
        '[auth] OS protected storage unavailable for Better Auth session; using main-process storage fallback.',
        error,
      )
      return `${PLAINTEXT_PREFIX}${Buffer.from(value, 'utf8').toString('base64url')}`
    }
  }

  private decodeAuthStorageValue(value: string): string | null {
    if (value.startsWith(PLAINTEXT_PREFIX)) {
      try {
        return Buffer.from(
          value.slice(PLAINTEXT_PREFIX.length),
          'base64url',
        ).toString('utf8')
      } catch {
        return null
      }
    }
    return unprotectValue(AUTH_STORAGE_SCOPE, value)
  }

  private readAuthStorage(): Record<string, string | null> {
    if (this.authStorageCache) {
      return this.authStorageCache
    }
    try {
      const raw = fs.readFileSync(this.getAuthStoragePath(), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const next: Record<string, string | null> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
          continue
        }
        next[key] = this.decodeAuthStorageValue(value)
      }
      this.authStorageCache = next
      return next
    } catch {
      this.authStorageCache = {}
      return this.authStorageCache
    }
  }

  private writeAuthStorage(values: Record<string, string | null>) {
    const encoded: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string') {
        encoded[key] = this.encodeAuthStorageValue(value)
      }
    }
    fs.mkdirSync(path.dirname(this.getAuthStoragePath()), { recursive: true })
    fs.writeFileSync(
      this.getAuthStoragePath(),
      JSON.stringify(encoded, null, 2),
      { mode: 0o600 },
    )
    this.authStorageCache = { ...values }
  }

  getAuthStorageItem(key: string): string | null {
    const normalizedKey = typeof key === 'string' ? key.trim() : ''
    if (!normalizedKey) {
      return null
    }
    return this.readAuthStorage()[normalizedKey] ?? null
  }

  setAuthStorageItem(key: string, value: string | null) {
    const normalizedKey = typeof key === 'string' ? key.trim() : ''
    if (!normalizedKey) {
      return
    }
    const storage = { ...this.readAuthStorage() }
    if (typeof value === 'string') {
      storage[normalizedKey] = value
    } else {
      delete storage[normalizedKey]
    }
    this.writeAuthStorage(storage)
  }

  private getRuntimeAuthState(): HostRuntimeAuthRefreshResult {
    return {
      authenticated: this.hostAuthAuthenticated && Boolean(this.hostAuthToken?.trim()),
      token: this.hostAuthToken?.trim() || null,
      hasConnectedAccount: this.hostHasConnectedAccount,
    }
  }

  private finishRuntimeAuthRefresh(result: HostRuntimeAuthRefreshResult) {
    if (this.runtimeAuthRefreshTimer) {
      clearTimeout(this.runtimeAuthRefreshTimer)
      this.runtimeAuthRefreshTimer = null
    }
    const resolve = this.runtimeAuthRefreshResolve
    this.runtimeAuthRefreshResolve = null
    this.runtimeAuthRefreshPromise = null
    this.runtimeAuthRefreshRequestId = null
    resolve?.(result)
  }

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
    // Always buffer the URL. The renderer-side `AuthDeepLinkHandler` is the
    // single source of truth for consumption: it pulls via
    // `auth:consumePendingCallback` on mount, which clears the buffer. We
    // additionally fire the live `auth:callback` broadcast as a best-effort
    // realtime notification for already-mounted handlers — but we no longer
    // clear the buffer on broadcast, because the broadcast is a no-op if it
    // races a window-creation gap (e.g. an `open-url` between `whenReady` and
    // `createInitialWindows`), and the OTT would silently disappear.
    // Server-side OTTs are single-use so a duplicate consume is harmless.
    this.pendingAuthCallback = url
    if (app.isReady()) {
      this.options.onAuthCallback(url)
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

  async requestRuntimeAuthRefresh(
    source: RuntimeAuthRefreshSource,
    broadcastRequest: (payload: { requestId: string; source: RuntimeAuthRefreshSource }) => void,
  ): Promise<HostRuntimeAuthRefreshResult> {
    if (this.runtimeAuthRefreshPromise) {
      return await this.runtimeAuthRefreshPromise
    }

    const requestId = randomUUID()
    this.runtimeAuthRefreshRequestId = requestId
    this.runtimeAuthRefreshPromise = new Promise<HostRuntimeAuthRefreshResult>((resolve) => {
      this.runtimeAuthRefreshResolve = resolve
      this.runtimeAuthRefreshTimer = setTimeout(() => {
        console.warn(
          `[auth] Runtime auth refresh timed out after ${source} request.`,
        )
        this.finishRuntimeAuthRefresh(this.getRuntimeAuthState())
      }, RUNTIME_AUTH_REFRESH_TIMEOUT_MS)
    })
    const pendingRefresh = this.runtimeAuthRefreshPromise

    try {
      broadcastRequest({ requestId, source })
    } catch (error) {
      console.warn('[auth] Failed to broadcast runtime auth refresh request.', error)
      this.finishRuntimeAuthRefresh(this.getRuntimeAuthState())
    }

    return await pendingRefresh
  }

  completeRuntimeAuthRefresh(payload: {
    requestId: string
    authenticated?: boolean
    token?: string | null
    hasConnectedAccount?: boolean
  }) {
    if (!this.runtimeAuthRefreshRequestId) {
      return { ok: false, accepted: false }
    }
    if (payload.requestId !== this.runtimeAuthRefreshRequestId) {
      return { ok: false, accepted: false }
    }

    this.setHostAuthState(
      Boolean(payload.authenticated),
      payload.token ?? undefined,
      payload.hasConnectedAccount,
    )
    this.finishRuntimeAuthRefresh(this.getRuntimeAuthState())
    return { ok: true, accepted: true }
  }

  clearPendingAuthCallback() {
    this.pendingAuthCallback = null
  }
}
