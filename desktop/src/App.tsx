import './App.css'
import { useUiState } from './app/state/ui-state'
import { getElectronApi } from './services/electron'
import { FullShell } from './screens/FullShell'
import { MiniShell } from './screens/MiniShell'

function App() {
  const { state } = useUiState()
  const api = getElectronApi()
  const params = new URLSearchParams(window.location.search)
  const isElectron = Boolean(api)
  const windowType =
    isElectron && params.get('window') === 'mini'
      ? 'mini'
      : isElectron
        ? 'full'
        : state.window

  return (
    <div className={`app window-${windowType}`}>
      {windowType === 'mini' ? <MiniShell /> : <FullShell />}
    </div>
  )
}

export default App
