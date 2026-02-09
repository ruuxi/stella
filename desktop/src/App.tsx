import { Suspense, lazy, useMemo } from 'react'
import { useUiState } from './app/state/ui-state'
import { getElectronApi } from './services/electron'
import { Authenticated } from 'convex/react'
import { AuthTokenBridge } from './app/AuthTokenBridge'
import { AuthDeepLinkHandler } from './app/AuthDeepLinkHandler'

type WindowType = 'full' | 'mini' | 'radial' | 'region'

const AppBootstrap = lazy(() =>
  import('./app/AppBootstrap').then((module) => ({ default: module.AppBootstrap })),
)
const CredentialRequestLayer = lazy(() =>
  import('./app/CredentialRequestLayer').then((module) => ({
    default: module.CredentialRequestLayer,
  })),
)
const FullShell = lazy(() =>
  import('./screens/FullShell').then((module) => ({ default: module.FullShell })),
)
const MiniShell = lazy(() =>
  import('./screens/MiniShell').then((module) => ({ default: module.MiniShell })),
)
const RadialShell = lazy(() =>
  import('./screens/RadialShell').then((module) => ({ default: module.RadialShell })),
)
const RegionCapture = lazy(() =>
  import('./screens/RegionCapture').then((module) => ({ default: module.RegionCapture })),
)

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
  const windowParam = useMemo(() => new URLSearchParams(window.location.search).get('window'), [])
  const isElectron = Boolean(api)
  const windowType = getWindowType(isElectron, windowParam, state.window)

  const shellFallback =
    windowType === 'radial' ? (
      <div className="app window-radial" />
    ) : windowType === 'region' ? (
      <div className="app window-region" />
    ) : (
      <div className={`app window-${windowType}`} />
    )

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
        <Authenticated>
          <AppBootstrap />
        </Authenticated>
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
      <Suspense fallback={shellFallback}>{shell}</Suspense>
    </>
  )
}

export default App
