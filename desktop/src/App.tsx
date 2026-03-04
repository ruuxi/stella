import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useUiState } from './providers/ui-state'
import { getElectronApi } from './services/electron'
import { AuthTokenBridge } from './app/auth/AuthTokenBridge'
import { CloudSyncBridge } from './services/CloudSyncBridge'
import { AutoAnonAuth } from './app/auth/AutoAnonAuth'
import { AuthDeepLinkHandler } from './app/auth/AuthDeepLinkHandler'
import { AppBootstrap } from './app/AppBootstrap'
import { ChatStoreProvider } from './providers/chat-store'
import { SelfModUpdateOverlay } from './app/shell/SelfModUpdateOverlay'

type WindowType = 'full' | 'mini'
const SELF_MOD_HMR_STORAGE_KEY = 'stella:self-mod-hmr-state'
const AUTO_REPAIR_SIGNATURE_KEY = 'stella:auto-repair:last-signature'
const SELF_MOD_HMR_STALE_MS = 120_000
const DEFAULT_SELF_MOD_MESSAGE = 'Stella is updating your interface.'
const CredentialRequestLayer = lazy(() =>
  import('./app/auth/CredentialRequestLayer').then((module) => ({
    default: module.CredentialRequestLayer,
  })),
)
const FullShell = lazy(() =>
  import('./app/shell/FullShell').then((module) => ({ default: module.FullShell })),
)
const MiniShell = lazy(() =>
  import('./app/shell/mini/MiniShell').then((module) => ({ default: module.MiniShell })),
)
function getWindowType(isElectron: boolean, windowParam: string | null, fallback: string): WindowType {
  if (!isElectron) {
    return fallback as WindowType
  }
  return windowParam === 'mini' ? 'mini' : 'full'
}

type PersistedSelfModHmrState = {
  paused: boolean
  message: string
  updatedAtMs: number
}

const readPersistedSelfModHmrState = (): PersistedSelfModHmrState | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(SELF_MOD_HMR_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedSelfModHmrState>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      paused: Boolean(parsed.paused),
      message:
        typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message.trim()
          : DEFAULT_SELF_MOD_MESSAGE,
      updatedAtMs: Number(parsed.updatedAtMs ?? 0),
    }
  } catch {
    return null
  }
}

function App() {
  const { state } = useUiState()
  const api = getElectronApi()
  const windowParam = useMemo(() => new URLSearchParams(window.location.search).get('window'), [])
  const isElectron = Boolean(api)
  const windowType = getWindowType(isElectron, windowParam, state.window)
  const [selfModHmr, setSelfModHmr] = useState(() => {
    const persisted = readPersistedSelfModHmrState()
    if (!persisted) {
      return { paused: false, message: DEFAULT_SELF_MOD_MESSAGE, updatedAtMs: 0 }
    }
    const fresh = Date.now() - persisted.updatedAtMs < SELF_MOD_HMR_STALE_MS
    if (!persisted.paused || !fresh) {
      return { paused: false, message: DEFAULT_SELF_MOD_MESSAGE, updatedAtMs: 0 }
    }
    return persisted
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY)
    }, 20_000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!api?.agent.onSelfModHmrState) return
    const unsubscribe = api.agent.onSelfModHmrState((event) => {
      setSelfModHmr({
        paused: Boolean(event.paused),
        message:
          typeof event.message === 'string' && event.message.trim()
            ? event.message.trim()
            : DEFAULT_SELF_MOD_MESSAGE,
        updatedAtMs: Date.now(),
      })
    })
    return () => unsubscribe()
  }, [api])

  useEffect(() => {
    if (!api?.agent.getActiveRun) return
    let cancelled = false
    void api.agent
      .getActiveRun()
      .then((activeRun) => {
        if (cancelled || !activeRun) return
        setSelfModHmr((prev) => {
          if (prev.paused) return prev
          return {
            paused: true,
            message: DEFAULT_SELF_MOD_MESSAGE,
            updatedAtMs: Date.now(),
          }
        })
      })
      .catch(() => {
        // Best effort.
      })
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!selfModHmr.paused) {
      window.sessionStorage.removeItem(SELF_MOD_HMR_STORAGE_KEY)
      return
    }
    window.sessionStorage.setItem(SELF_MOD_HMR_STORAGE_KEY, JSON.stringify(selfModHmr))
  }, [selfModHmr])

  useEffect(() => {
    if (!selfModHmr.paused) return
    const remainingMs = SELF_MOD_HMR_STALE_MS - (Date.now() - selfModHmr.updatedAtMs)
    const timeoutMs = Math.max(5_000, remainingMs)
    const timer = window.setTimeout(() => {
      setSelfModHmr((prev) => {
        if (!prev.paused) return prev
        return {
          paused: false,
          message: DEFAULT_SELF_MOD_MESSAGE,
          updatedAtMs: Date.now(),
        }
      })
    }, timeoutMs)
    return () => window.clearTimeout(timer)
  }, [selfModHmr.paused, selfModHmr.updatedAtMs])

  const shell = (
    <div className={`app window-${windowType}`}>
      <ChatStoreProvider>
        <AppBootstrap />
        <CredentialRequestLayer />
        {windowType === 'mini' ? <MiniShell /> : <FullShell />}
        <SelfModUpdateOverlay
          visible={selfModHmr.paused}
          message={selfModHmr.message || DEFAULT_SELF_MOD_MESSAGE}
        />
      </ChatStoreProvider>
    </div>
  )

  return (
    <>
      <AuthDeepLinkHandler />
      <AutoAnonAuth />
      <AuthTokenBridge />
      <CloudSyncBridge />
      <Suspense fallback={<div className={`app window-${windowType}`} />}>{shell}</Suspense>
    </>
  )
}

export { App }


