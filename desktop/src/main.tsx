import { createRoot } from 'react-dom/client'
import { ConvexBetterAuthProvider, type AuthClient } from '@convex-dev/better-auth/react'
import './index.css'
import './ui/register-styles'
import './styles/app-base.css'
import './styles/app-components.css'

import './lib/vite-error-recovery'
import { initStellaUiHandler } from './services/stella-ui-handler'

initStellaUiHandler()
import { App } from './App.tsx'
import { ErrorBoundary } from './app/ErrorBoundary'
import { UiStateProvider } from './providers/ui-state'
import { WorkspaceProvider } from './providers/workspace-state'
import { ThemeProvider } from './theme/theme-context'
import { convexClient } from './services/convex-client'
import { authClient } from './lib/auth-client'
const authClientForProvider = authClient as unknown as AuthClient

document.documentElement.dataset.stellaWindow = 'full'

const appTree = (
  <ThemeProvider>
    <UiStateProvider>
      <WorkspaceProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </WorkspaceProvider>
    </UiStateProvider>
  </ThemeProvider>
)

createRoot(document.getElementById('root')!).render(
  <ConvexBetterAuthProvider client={convexClient} authClient={authClientForProvider}>
    {appTree}
  </ConvexBetterAuthProvider>,
)


