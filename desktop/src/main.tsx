import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
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
import './components/typewriter.css'
import './components/image-preview.css'
import './components/tag.css'
import './components/progress-circle.css'
import './components/keybind.css'
import './components/resize-handle.css'
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
