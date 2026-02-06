import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/overlays.css'
import { ThemeProvider } from './theme/theme-context'
import { RadialDial } from './screens/RadialDial'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <div className="app window-radial">
        <div className="radial-shell">
          <RadialDial />
        </div>
      </div>
    </ThemeProvider>
  </StrictMode>,
)
