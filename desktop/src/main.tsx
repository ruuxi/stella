import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
import './index.css'
import App from './App.tsx'
import { UiStateProvider } from './app/state/ui-state'
import { ThemeProvider } from './theme/theme-context'
import { convexClient } from './services/convex-client'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexProvider client={convexClient}>
      <ThemeProvider>
        <UiStateProvider>
          <App />
        </UiStateProvider>
      </ThemeProvider>
    </ConvexProvider>
  </StrictMode>,
)
