import { lazy, Suspense } from 'react'

/**
 * Auth and Connect render as URL-driven dialogs (`?dialog=auth|connect`).
 * Settings is a top-level route (`/settings`), not a dialog.
 */
export type DialogType = 'auth' | 'connect' | null

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
}

export function FullShellDialogs({
  activeDialog,
  onDialogOpenChange,
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
    </>
  )
}
