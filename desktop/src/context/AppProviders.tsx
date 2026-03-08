import type { ReactNode } from 'react'
import { ThemeProvider } from './theme-context'
import { UiStateProvider } from './ui-state'
import { WorkspaceProvider } from './workspace-state'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <UiStateProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </UiStateProvider>
    </ThemeProvider>
  )
}
