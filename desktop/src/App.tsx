import { useUiState } from './app/state/ui-state'
import { getElectronApi } from './services/electron'
import { AppBootstrap } from './app/AppBootstrap'
import { CredentialRequestLayer } from './app/CredentialRequestLayer'
import { FullShell } from './screens/FullShell'
import { MiniShell } from './screens/MiniShell'
import { RadialShell } from './screens/RadialShell'
import { RegionCapture } from './screens/RegionCapture'
import { Authenticated } from 'convex/react'
import { AuthTokenBridge } from './app/AuthTokenBridge'
import { AuthDeepLinkHandler } from './app/AuthDeepLinkHandler'

type WindowType = 'full' | 'mini' | 'radial' | 'region'

function getWindowType(isElectron: boolean, windowParam: string | null, fallback: string): WindowType {
  if (!isElectron) {
    return fallback as WindowType
  }
  switch (windowParam) {
    case 'radial':
    case 'region':
    case 'mini':
      return windowParam
    default:
      return 'full'
  }
}

function App() {
  const { state } = useUiState()
  const api = getElectronApi()
  const params = new URLSearchParams(window.location.search)
  const isElectron = Boolean(api)
  const windowType = getWindowType(isElectron, params.get('window'), state.window)

  const shell =
    windowType === 'radial' ? (
      <div className="app window-radial">
        <RadialShell />
      </div>
    ) : windowType === 'region' ? (
      <div className="app window-region">
        <RegionCapture />
      </div>
    ) : (
      <div className={`app window-${windowType}`}>
        <AppBootstrap />
        <CredentialRequestLayer />
        {windowType === 'mini' ? <MiniShell /> : <FullShell />}
      </div>
    )

  // Always show the shell - auth is handled inline with a dialog
  return (
    <>
      <AuthDeepLinkHandler />
      <Authenticated>
        <AuthTokenBridge />
      </Authenticated>
      {shell}
    </>
  )
}

export default App
