import './App.css'
import { useUiState } from './app/state/ui-state'
import { getElectronApi } from './services/electron'
import { AppBootstrap } from './app/AppBootstrap'
import { CredentialRequestLayer } from './app/CredentialRequestLayer'
import { FullShell } from './screens/FullShell'
import { MiniShell } from './screens/MiniShell'
import { RadialShell } from './screens/RadialShell'
import { Authenticated, AuthLoading, Unauthenticated } from 'convex/react'
import { AuthPanel } from './app/AuthPanel'
import { AuthTokenBridge } from './app/AuthTokenBridge'
import { AuthDeepLinkHandler } from './app/AuthDeepLinkHandler'

type WindowType = 'full' | 'mini' | 'radial'

function App() {
  const { state } = useUiState()
  const api = getElectronApi()
  const params = new URLSearchParams(window.location.search)
  const isElectron = Boolean(api)
  const windowParam = params.get('window')

  let windowType: WindowType
  if (isElectron && windowParam === 'radial') {
    windowType = 'radial'
  } else if (isElectron && windowParam === 'mini') {
    windowType = 'mini'
  } else if (isElectron) {
    windowType = 'full'
  } else {
    windowType = state.window as WindowType
  }

  const shell =
    windowType === 'radial' ? (
      <div className="app window-radial">
        <RadialShell />
      </div>
    ) : (
      <div className={`app window-${windowType}`}>
        <AppBootstrap />
        <CredentialRequestLayer />
        {windowType === 'mini' ? <MiniShell /> : <FullShell />}
      </div>
    )

  return (
    <>
      <AuthDeepLinkHandler />
      <AuthLoading>
        <div className="auth-panel">
          <div className="auth-panel-card">
            <div className="auth-panel-title">Loading...</div>
          </div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <AuthPanel />
      </Unauthenticated>
      <Authenticated>
        <AuthTokenBridge />
        {shell}
      </Authenticated>
    </>
  )
}

export default App
