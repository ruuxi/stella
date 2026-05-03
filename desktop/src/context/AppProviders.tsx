import type { ReactNode } from 'react'
import { ThemeProvider } from './theme-context'
import { UiStateProvider } from './ui-state'
import { ToastProvider } from '@/ui/toast'
import { BootstrapStateProvider } from '@/systems/boot/bootstrap-state'
import { I18nProvider } from '@/shared/i18n'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <BootstrapStateProvider>
            <UiStateProvider>{children}</UiStateProvider>
          </BootstrapStateProvider>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  )
}
