import { createRoot } from 'react-dom/client'
import { ConvexBetterAuthProvider, type AuthClient } from '@convex-dev/better-auth/react'
import './index.css'
import './ui/button.css'
import './ui/dropdown-menu.css'
import './ui/spinner.css'
import './ui/text-field.css'
import './ui/checkbox.css'
import './ui/switch.css'
import './ui/radio-group.css'
import './ui/select.css'
import './ui/slider.css'
import './ui/icon-button.css'
import './ui/inline-input.css'
import './ui/card.css'
import './ui/accordion.css'
import './ui/collapsible.css'
import './ui/tabs.css'
import './ui/list.css'
import './ui/dialog.css'
import './ui/popover.css'
import './app/settings/ThemePicker.css'
import './ui/hover-card.css'
import './ui/tooltip.css'
import './ui/toast.css'
import './app/shell/header-tab-bar.css'
import './app/shell/floating-orb.css'
import './app/overlay/voice-overlay.css'
import './ui/icon.css'
import './ui/avatar.css'
import './ui/code.css'
import './ui/image-preview.css'
import './ui/tag.css'
import './ui/progress-circle.css'
import './ui/keybind.css'
import './ui/resize-handle.css'
import './ui/steps-container.css'
import './app/auth/auth-panel.css'

// App-level layout + screen styles (kept in a separate folder)
import './app/sidebar/sidebar.css'
import './styles/app-base.css'
import './app/shell/full-shell.layout.css'
import './app/shell/full-shell.panels.css'
import './app/chat/full-shell.chat.css'
import './app/chat/full-shell.composer.css'
import './app/shell/mini/mini-shell.css'
import './app/overlay/overlays.css'
import './styles/app-components.css'
import './app/chat/indicators.css'
import './app/integrations/credential-modal.css'
import './app/canvas/workspace.css'
import './app/chat/chat-panel.css'
import './app/canvas/renderers/canvas-renderers.css'
// settings.css, selfmod-demo.css: co-located with their lazy-loaded components
import './app/chat/selfmod-undo.css'
import './app/chat/command-chips.css'
import './app/chat/welcome-suggestions.css'
import './app/error-boundary.css'

import './lib/vite-error-recovery'
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
    <ErrorBoundary>
      <UiStateProvider>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </UiStateProvider>
    </ErrorBoundary>
  </ThemeProvider>
)

createRoot(document.getElementById('root')!).render(
  <ConvexBetterAuthProvider client={convexClient} authClient={authClientForProvider}>
    {appTree}
  </ConvexBetterAuthProvider>,
)


