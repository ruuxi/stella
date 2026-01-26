import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { UiStateProvider } from './app/state/ui-state'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiStateProvider>
      <App />
    </UiStateProvider>
  </StrictMode>,
)
