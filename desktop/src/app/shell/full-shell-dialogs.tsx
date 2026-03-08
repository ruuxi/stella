import { lazy, Suspense } from 'react'
import type { DialogType } from './types'

const SettingsDialog = lazy(() => import('../settings/SettingsView'))
const AuthDialog = lazy(() =>
  import('@/app/auth/AuthDialog').then((module) => ({
    default: module.AuthDialog,
  })),
)
const ConnectDialog = lazy(() =>
  import('@/app/integrations/ConnectDialog').then((module) => ({
    default: module.ConnectDialog,
  })),
)
const SelfModTestDialog = lazy(() => import('@/testing/SelfModTestDialog'))
const TraceViewerDialog = lazy(() => import('@/testing/TraceViewerDialog'))

type FullShellDialogsProps = {
  activeDialog: DialogType
  isDev: boolean
  onDialogOpenChange: (open: boolean) => void
  onSignOut: () => void
  onResetOnboarding: () => void
  onShowTestDialog: () => void
  onShowTraceDialog: () => void
}

const DevControls = ({
  onResetOnboarding,
  onShowTestDialog,
  onShowTraceDialog,
}: Pick<
  FullShellDialogsProps,
  'onResetOnboarding' | 'onShowTestDialog' | 'onShowTraceDialog'
>) => (
  <div className="dev-controls">
    <button className="onboarding-reset" onClick={onResetOnboarding}>
      Reset Onboarding
    </button>
    <button className="onboarding-reset" onClick={onShowTestDialog}>
      Test UI
    </button>
    <button className="onboarding-reset" onClick={onShowTraceDialog}>
      Trace
    </button>
  </div>
)

export function FullShellDialogs({
  activeDialog,
  isDev,
  onDialogOpenChange,
  onSignOut,
  onResetOnboarding,
  onShowTestDialog,
  onShowTraceDialog,
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

      {isDev && (
        <DevControls
          onResetOnboarding={onResetOnboarding}
          onShowTestDialog={onShowTestDialog}
          onShowTraceDialog={onShowTraceDialog}
        />
      )}

      {isDev && activeDialog === 'test' && (
        <Suspense fallback={null}>
          <SelfModTestDialog open onOpenChange={onDialogOpenChange} />
        </Suspense>
      )}
      {isDev && activeDialog === 'trace' && (
        <Suspense fallback={null}>
          <TraceViewerDialog open onOpenChange={onDialogOpenChange} />
        </Suspense>
      )}
    </>
  )
}
