import { Suspense, lazy, useEffect } from 'react'
import { useUiState } from '@/context/ui-state'
import { getElectronApi } from '@/platform/electron/electron'
import { AuthDeepLinkHandler } from './app/auth/AuthDeepLinkHandler'
import { AppBootstrap } from './app/AppBootstrap'
import { ModelPreferencesBridge } from '@/app/settings/ModelPreferencesBridge'
import { ChatStoreProvider } from '@/context/chat-store'

type WindowType = 'full' | 'mini'
const AUTO_REPAIR_SIGNATURE_KEY = 'stella:auto-repair:last-signature'
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

function App() {
  const { state } = useUiState()
  const api = getElectronApi()
  const windowParam = new URLSearchParams(window.location.search).get('window')
  const isElectron = Boolean(api)
  const windowType = getWindowType(isElectron, windowParam, state.window)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY)
    }, 20_000)
    return () => window.clearTimeout(timer)
  }, [])

  const shell = (
    <div className={`app window-${windowType}`}>
      <ChatStoreProvider>
        <AppBootstrap />
        <ModelPreferencesBridge />
        <CredentialRequestLayer />
        {windowType === 'mini' ? <MiniShell /> : <FullShell />}
      </ChatStoreProvider>
    </div>
  )

  return (
    <>
      <AuthDeepLinkHandler />
      <Suspense fallback={<div className={`app window-${windowType}`} />}>{shell}</Suspense>
    </>
  )
}

export { App }
