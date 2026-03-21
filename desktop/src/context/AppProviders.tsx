import type { ReactNode } from 'react'
import { DevProjectsProvider } from './dev-projects-state'
import { ThemeProvider } from './theme-context'
import { UiStateProvider } from './ui-state'
import { WorkspaceProvider } from './workspace-state'
import { ToastProvider } from '@/ui/toast'
import { BootstrapStateProvider } from '@/systems/boot/bootstrap-state'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BootstrapStateProvider>
          <UiStateProvider>
            <DevProjectsProvider>
              <WorkspaceProvider>{children}</WorkspaceProvider>
            </DevProjectsProvider>
          </UiStateProvider>
        </BootstrapStateProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
