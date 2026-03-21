import { lazy, Suspense } from 'react'

export type DialogType = 'auth' | 'connect' | 'settings' | null

const SettingsDialog = lazy(() => import('@/global/settings/SettingsView'))
const AuthDialog = lazy(() =>
  import('@/global/auth/AuthDialog').then((module) => ({
    default: module.AuthDialog,
  })),
)
const ConnectDialog = lazy(() =>
  import('@/global/integrations/ConnectDialog').then((module) => ({
    default: module.ConnectDialog,
  })),
)

type FullShellDialogsProps = {
  activeDialog: DialogType
  onDialogOpenChange: (open: boolean) => void
  onSignOut: () => void
}

export function FullShellDialogs({
  activeDialog,
  onDialogOpenChange,
  onSignOut,
}: FullShellDialogsProps) {
  return (
    <>
      {activeDialog === 'auth' && (
        <Suspense fallback={null}>
          <AuthDialog open onOpenChange={onDialogOpenChange} />
        </Suspense>
      )}
      {activeDialog === 'connect' && (
        <Suspense fallback={null}>
          <ConnectDialog open onOpenChange={onDialogOpenChange} />
        </Suspense>
      )}
      {activeDialog === 'settings' && (
        <Suspense fallback={null}>
          <SettingsDialog
            open
            onOpenChange={onDialogOpenChange}
            onSignOut={onSignOut}
          />
        </Suspense>
      )}
    </>
  )
}

