import { Suspense, lazy, useEffect, useState } from 'react'
import { useUiState } from './providers/ui-state'
import { getElectronApi } from './services/electron'
import { AuthTokenBridge } from './app/auth/AuthTokenBridge'
import { CloudSyncBridge } from './services/CloudSyncBridge'
import { AutoAnonAuth } from './app/auth/AutoAnonAuth'
import { AuthDeepLinkHandler } from './app/auth/AuthDeepLinkHandler'
import { AppBootstrap } from './app/AppBootstrap'
import { ChatStoreProvider } from './providers/chat-store'
import { SelfModUpdateOverlay, type SelfModOverlayPhase } from './app/shell/SelfModUpdateOverlay'

type WindowType = 'full' | 'mini'
const SELF_MOD_HMR_STORAGE_KEY = 'stella:self-mod-hmr-state'
const AUTO_REPAIR_SIGNATURE_KEY = 'stella:auto-repair:last-signature'
const SELF_MOD_HMR_STALE_MS = 120_000
const SELF_MOD_HMR_RESUME_HOLD_MS = 850
const SELF_MOD_HMR_RESUME_FADE_MS = 380
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

type OverlayPhase = SelfModOverlayPhase | 'hidden'

type PersistedSelfModHmrState = {
  phase: OverlayPhase
  message: string
  updatedAtMs: number
  holdUntilMs: number
}

const normalizeSelfModMessage = (message?: string): string =>
  typeof message === 'string' && message.trim() ? message.trim() : DEFAULT_SELF_MOD_MESSAGE

const createHiddenSelfModState = (): PersistedSelfModHmrState => ({
  phase: 'hidden',
  message: DEFAULT_SELF_MOD_MESSAGE,
  updatedAtMs: 0,
  holdUntilMs: 0,
})

const createSelfModState = (
  phase: 'active' | 'hold',
  message?: string,
): PersistedSelfModHmrState => ({
  phase,
  message: normalizeSelfModMessage(message),
  updatedAtMs: Date.now(),
  holdUntilMs: phase === 'hold' ? Date.now() + SELF_MOD_HMR_RESUME_HOLD_MS : 0,
})

const readPersistedSelfModHmrState = (): PersistedSelfModHmrState | null => {
  try {
    const raw = window.sessionStorage.getItem(SELF_MOD_HMR_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedSelfModHmrState>
    if (!parsed || typeof parsed !== 'object') return null
    const phase = parsed.phase
    if (phase !== 'active' && phase !== 'hold' && phase !== 'fade' && phase !== 'hidden') return null
    return {
      phase,
      message: normalizeSelfModMessage(parsed.message),
      updatedAtMs: Number(parsed.updatedAtMs ?? 0),
      holdUntilMs: Number(parsed.holdUntilMs ?? 0),
    }
  } catch {
    return null
  }
}

function App() {
  const { state } = useUiState()
  const api = getElectronApi()
  const windowParam = new URLSearchParams(window.location.search).get('window')
  const isElectron = Boolean(api)
  const windowType = getWindowType(isElectron, windowParam, state.window)
  const [selfModHmr, setSelfModHmr] = useState<PersistedSelfModHmrState>(() => {
    const persisted = readPersistedSelfModHmrState()
    if (!persisted) {
      return createHiddenSelfModState()
    }
    if (persisted.phase === 'active') {
      const fresh = Date.now() - persisted.updatedAtMs < SELF_MOD_HMR_STALE_MS
      if (!fresh) {
        return createHiddenSelfModState()
      }
    }
    if (persisted.phase === 'hold' || persisted.phase === 'fade') {
      const fresh = Date.now() - persisted.updatedAtMs < 10_000
      if (!fresh) {
        return createHiddenSelfModState()
      }
    }
    return persisted
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY)
    }, 20_000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!api?.agent?.onSelfModHmrState) return
    const unsubscribe = api.agent.onSelfModHmrState((event) => {
      const nextMessage = normalizeSelfModMessage(event.message)
      setSelfModHmr((prev) => {
        if (event.paused) {
          return createSelfModState('active', nextMessage)
        }
        if (prev.phase === 'hidden') {
          return prev
        }
        return createSelfModState('hold', prev.message || nextMessage)
      })
    })
    return () => unsubscribe()
  }, [api])

  useEffect(() => {
    if (!api?.agent?.getActiveRun) return
    let cancelled = false
    void api.agent
      .getActiveRun()
      .then((activeRun) => {
        if (cancelled || !activeRun) return
        setSelfModHmr((prev) => {
          if (prev.phase === 'active') return prev
          return createSelfModState('active', DEFAULT_SELF_MOD_MESSAGE)
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
    if (selfModHmr.phase === 'hidden') {
      window.sessionStorage.removeItem(SELF_MOD_HMR_STORAGE_KEY)
      return
    }
    window.sessionStorage.setItem(SELF_MOD_HMR_STORAGE_KEY, JSON.stringify(selfModHmr))
  }, [selfModHmr])

  useEffect(() => {
    if (selfModHmr.phase !== 'active') return
    const remainingMs = SELF_MOD_HMR_STALE_MS - (Date.now() - selfModHmr.updatedAtMs)
    const timeoutMs = Math.max(5_000, remainingMs)
    const timer = window.setTimeout(() => {
      void api?.agent
        .getActiveRun?.()
        .then((activeRun) => {
          setSelfModHmr((prev) => {
            if (prev.phase !== 'active') return prev
            if (activeRun) {
              return {
                ...prev,
                updatedAtMs: Date.now(),
              }
            }
            return createSelfModState('hold', prev.message)
          })
        })
        .catch(() => {
          setSelfModHmr((prev) => {
            if (prev.phase !== 'active') return prev
            return createSelfModState('hold', prev.message)
          })
        })
    }, timeoutMs)
    return () => window.clearTimeout(timer)
  }, [api, selfModHmr.phase, selfModHmr.updatedAtMs])

  useEffect(() => {
    if (selfModHmr.phase !== 'hold') return
    const remainingMs = selfModHmr.holdUntilMs - Date.now()
    const holdMs = Math.max(60, remainingMs)
    const timer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setSelfModHmr((prev) => {
            if (prev.phase !== 'hold') return prev
            return {
              ...prev,
              phase: 'fade',
              updatedAtMs: Date.now(),
            }
          })
        })
      })
    }, holdMs)
    return () => window.clearTimeout(timer)
  }, [selfModHmr.holdUntilMs, selfModHmr.phase])

  useEffect(() => {
    if (selfModHmr.phase !== 'fade') return
    const timer = window.setTimeout(() => {
      setSelfModHmr((prev) => {
        if (prev.phase !== 'fade') return prev
        return createHiddenSelfModState()
      })
    }, SELF_MOD_HMR_RESUME_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [selfModHmr.phase])

  const overlayPhase = selfModHmr.phase === 'hidden' ? null : selfModHmr.phase

  const shell = (
    <div className={`app window-${windowType}`}>
      <ChatStoreProvider>
        <AppBootstrap />
        <CredentialRequestLayer />
        {windowType === 'mini' ? <MiniShell /> : <FullShell />}
        <SelfModUpdateOverlay
          visible={overlayPhase !== null}
          phase={overlayPhase ?? 'active'}
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
