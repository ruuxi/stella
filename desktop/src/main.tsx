import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
import './index.css'
import App from './App.tsx'
import { UiStateProvider } from './app/state/ui-state'
import { convexClient } from './services/convex-client'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexProvider client={convexClient}>
      <UiStateProvider>
        <App />
      </UiStateProvider>
    </ConvexProvider>
  </StrictMode>,
)
