/**
 * Shared toast CTAs for "you need to sign in / connect a provider" prompts.
 *
 * Features like dictation and realtime voice fall back to a managed backend
 * (or a user-configured provider) that requires authentication. When that
 * fails they used to enter a silent error state, leaving the user to assume
 * the feature is broken when they simply aren't signed in / connected. These
 * actions mirror the chat provider-error toast (`stella-provider-error-toast`)
 * so the guidance — and the navigation target — stays consistent across the
 * app. Router is imported lazily so this stays usable from non-React modules.
 */
import type { ToastOptions } from '@/ui/toast'

type ToastAction = NonNullable<ToastOptions['action']>

export const SIGN_IN_TOAST_ACTION: ToastAction = {
  label: 'Sign in',
  onClick: () => {
    void import('@/router').then(({ router }) => {
      void router.navigate({
        to: '.',
        search: (prev: { dialog?: 'auth' | 'connect' }) => ({
          ...prev,
          dialog: 'auth' as const,
        }),
      })
    })
  },
}

export const OPEN_SETTINGS_TOAST_ACTION: ToastAction = {
  label: 'Open settings',
  onClick: () => {
    void import('@/features/workspace-display/sidebar-sections').then(
      ({ sidebarSections }) => {
        sidebarSections.openLocation('settings', null)
      },
    )
  },
}
