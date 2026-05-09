import { router } from '@/router'
import type { ToastOptions } from '@/ui/toast'

const normalizeErrorText = (value: string | null | undefined): string =>
  (value ?? '').trim()

const openBilling = () => {
  void router.navigate({ to: '/billing' })
}

const upgradeAction = {
  label: 'Upgrade',
  onClick: openBilling,
}

export const resolveStellaProviderErrorToast = (
  reason: string | null | undefined,
): ToastOptions => {
  const message = normalizeErrorText(reason)
  const normalized = message.toLowerCase()

  if (
    normalized.includes('usage limit reached') ||
    normalized.includes('managed-model limits reached')
  ) {
    return {
      title: 'Stella needs more room',
      description:
        'You have reached the limit for your current plan. Upgrade to keep going, or wait until usage resets.',
      variant: 'error',
      duration: 8000,
      action: upgradeAction,
    }
  }

  if (normalized.includes('rate limit exceeded')) {
    return {
      title: 'Stella is moving too fast',
      description:
        'You have hit a temporary usage limit. Upgrade for more capacity, or try again shortly.',
      variant: 'error',
      duration: 8000,
      action: upgradeAction,
    }
  }

  return {
    title: 'Something went wrong',
    description: message || undefined,
    variant: 'error',
  }
}
