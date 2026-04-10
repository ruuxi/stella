import type { ReactNode } from 'react'
import { ThemeProvider } from './theme-context'
import { UiStateProvider } from './ui-state'
import { ToastProvider } from '@/ui/toast'
import { BootstrapStateProvider } from '@/systems/boot/bootstrap-state'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BootstrapStateProvider>
          <UiStateProvider>
            {children}
          </UiStateProvider>
        </BootstrapStateProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
