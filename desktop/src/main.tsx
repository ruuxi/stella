import { createRoot } from 'react-dom/client'
import { ConvexBetterAuthProvider, type AuthClient } from '@convex-dev/better-auth/react'
import './index.css'
import './ui/register-styles'
import './styles/app-base.css'
import './styles/app-components.css'

import './platform/dev/vite-error-recovery'
import { initStellaUiHandler } from './platform/electron/stella-ui-handler'

initStellaUiHandler()
import { App } from './App.tsx'
import { ErrorBoundary } from './app/ErrorBoundary'
import { AppProviders } from './context/AppProviders'
import { convexClient } from './infra/convex-client'
import { authClient } from './app/auth/lib/auth-client'
const authClientForProvider = authClient as unknown as AuthClient

document.documentElement.dataset.stellaWindow = 'full'

const appTree = (
  <AppProviders>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </AppProviders>
)

createRoot(document.getElementById('root')!).render(
  <ConvexBetterAuthProvider client={convexClient} authClient={authClientForProvider}>
    {appTree}
  </ConvexBetterAuthProvider>,
)


