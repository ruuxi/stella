import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexBetterAuthProvider, type AuthClient } from '@convex-dev/better-auth/react'
import './index.css'
import './components/button.css'
import './components/dropdown-menu.css'
import './components/spinner.css'
import './components/text-field.css'
import './components/checkbox.css'
import './components/switch.css'
import './components/radio-group.css'
import './components/select.css'
import './components/slider.css'
import './components/icon-button.css'
import './components/inline-input.css'
import './components/card.css'
import './components/accordion.css'
import './components/collapsible.css'
import './components/tabs.css'
import './components/list.css'
import './components/dialog.css'
import './components/popover.css'
import './components/ThemePicker.css'
import './components/hover-card.css'
import './components/tooltip.css'
import './components/toast.css'
import './components/icon.css'
import './components/avatar.css'
import './components/code.css'
import './components/image-preview.css'
import './components/tag.css'
import './components/progress-circle.css'
import './components/keybind.css'
import './components/resize-handle.css'
import './components/steps-container.css'
import './components/auth-panel.css'

// App-level layout + screen styles (kept in a separate folder)
import './components/sidebar.css'
import './styles/app-base.css'
import './styles/full-shell.layout.css'
import './styles/full-shell.panels.css'
import './styles/full-shell.chat.css'
import './styles/full-shell.composer.css'
import './styles/mini-shell.css'
import './styles/overlays.css'
import './styles/app-components.css'
import './styles/indicators.css'
import './styles/credential-modal.css'
import './styles/canvas-panel.css'
import './styles/canvas-renderers.css'
import './styles/store.css'
import './styles/settings.css'
import './styles/selfmod-demo.css'
import './styles/command-chips.css'
import './styles/welcome-suggestions.css'

import App from './App.tsx'
import { UiStateProvider } from './app/state/ui-state'
import { CanvasProvider } from './app/state/canvas-state'
import { ThemeProvider } from './theme/theme-context'
import { convexClient } from './services/convex-client'
import { authClient } from './lib/auth-client'

const authClientForProvider = authClient as unknown as AuthClient

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexBetterAuthProvider client={convexClient} authClient={authClientForProvider}>
      <ThemeProvider>
        <UiStateProvider>
          <CanvasProvider>
            <App />
          </CanvasProvider>
        </UiStateProvider>
      </ThemeProvider>
    </ConvexBetterAuthProvider>
  </StrictMode>,
)
