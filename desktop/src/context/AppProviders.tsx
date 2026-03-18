import type { ReactNode } from 'react'
import { DevProjectsProvider } from './dev-projects-state'
import { ThemeProvider } from './theme-context'
import { UiStateProvider } from './ui-state'
import { WorkspaceProvider } from './workspace-state'
import { ToastProvider } from '@/ui/toast'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <UiStateProvider>
          <DevProjectsProvider>
            <WorkspaceProvider>{children}</WorkspaceProvider>
          </DevProjectsProvider>
        </UiStateProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
