import { lazy, Suspense } from 'react'

/**
 * Auth and Connect render as URL-driven dialogs (`?dialog=auth|connect`).
 * Settings is a top-level route (`/settings`), not a dialog.
 *
 * Both chunks are warmed by sidebar hover/focus handlers
 * (`preloadAuthDialog` / `preloadConnectDialog` in
 * `@/shared/lib/sidebar-preloads`) and again at idle from `FullShell` via
 * `preloadAllSidebarSurfaces`, so by the time the user actually sets
 * `?dialog=...` the chunk is already in memory and `Suspense` falls
 * straight through.
 */
type DialogType = 'auth' | 'connect' | null

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
