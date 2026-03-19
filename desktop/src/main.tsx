import { createRoot } from 'react-dom/client'
import './index.css'
import './ui/register-styles'
import './shared/styles/app-base.css'
import './shared/styles/app-components.css'

import './platform/dev/vite-error-recovery'
import { initStellaUiHandler } from './platform/electron/stella-ui-handler'

initStellaUiHandler()
import { App } from './App.tsx'
import { DesktopConvexAuthProvider } from './global/auth/DesktopConvexAuthProvider'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { AppProviders } from './context/AppProviders'

document.documentElement.dataset.stellaWindow = 'full'

const appTree = (
  <AppProviders>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </AppProviders>
)

createRoot(document.getElementById('root')!).render(
  <DesktopConvexAuthProvider>
    {appTree}
  </DesktopConvexAuthProvider>,
)



