import './App.css'
import { useUiState } from './app/state/ui-state'
import { getElectronApi } from './services/electron'
import { AppBootstrap } from './app/AppBootstrap'
import { FullShell } from './screens/FullShell'
import { MiniShell } from './screens/MiniShell'
import { RadialShell } from './screens/RadialShell'

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

  // Radial window is a special transparent overlay
  if (windowType === 'radial') {
    return (
      <div className="app window-radial">
        <RadialShell />
      </div>
    )
  }

  return (
    <div className={`app window-${windowType}`}>
      <AppBootstrap />
      {windowType === 'mini' ? <MiniShell /> : <FullShell />}
    </div>
  )
}

export default App
