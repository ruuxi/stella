import { router } from '@/router'
import { BYOK_TOAST_ACTION } from '@/shared/billing/byok-action'
import type { ToastOptions } from '@/ui/toast'

const normalizeErrorText = (value: string | null | undefined): string =>
  (value ?? '').trim()

const openBilling = () => {
  void router.navigate({ to: '/billing' })
}

const openSignInDialog = () => {
  void router.navigate({
    to: '.',
    search: (prev) => ({
      ...prev,
      dialog: 'auth' as const,
    }),
  })
}

const upgradeAction = {
  label: 'Upgrade',
  onClick: openBilling,
}

const signInAction = {
  label: 'Sign in',
  onClick: openSignInDialog,
}

const signInRequiredMatchers = [
  'sign in required',
] as const

const billingMatchers = [
  'usage limit reached',
  'managed-model limits reached',
] as const

const rateLimitMatchers = [
  'rate limit exceeded',
  'too many requests',
] as const

const authMatchers = [
  'unauthorized',
  'unauthenticated',
  'invalid token',
  'token expired',
  'expired token',
] as const

const modelRestrictionMatchers = [
  'unsupported stella model selection',
  'invalid stella model selection',
  'model not available',
  'model is not available',
] as const

const serviceUnavailableMatchers = [
  'upstream gateway is not configured',
  'stella runtime returned no response body',
  'stella runtime error: 5',
  'failed to generate stella completion',
  'streaming completion failed',
] as const

const malformedRequestMatchers = [
  'stella request body must be valid json',
  'received text_delta for non-text content',
  'received text_end for non-text content',
  'received thinking_delta for non-thinking content',
  'received thinking_end for non-thinking content',
  'received toolcall_delta for non-toolcall content',
] as const

const includesAny = (
  normalized: string,
  matchers: readonly string[],
): boolean => matchers.some((matcher) => normalized.includes(matcher))

export const resolveStellaProviderErrorToast = (
  reason: string | null | undefined,
): ToastOptions => {
  const message = normalizeErrorText(reason)
  const normalized = message.toLowerCase()

  // Anonymous-cap branch must come before the generic rate-limit branch:
  // anon users get a "Sign in" CTA instead of "Upgrade" → /billing
  // (they have no account to upgrade). Backend marker:
  // `stella_provider/authorization.ts` 429 message.
  if (includesAny(normalized, signInRequiredMatchers)) {
    return {
      title: 'Sign in to keep using Stella',
      description:
        "You've used your free Stella previews. Sign in to keep going, or use your own provider key.",
      variant: 'error',
      duration: 8000,
      action: signInAction,
      secondaryAction: BYOK_TOAST_ACTION,
    }
  }

  if (includesAny(normalized, billingMatchers)) {
    return {
      title: 'Stella needs more room',
      description:
        'You have reached the limit for your current plan. Upgrade to keep going, or wait until usage resets.',
      variant: 'error',
      duration: 8000,
      action: upgradeAction,
      secondaryAction: BYOK_TOAST_ACTION,
    }
  }

  if (includesAny(normalized, rateLimitMatchers)) {
    return {
      title: 'Stella is moving too fast',
      description:
        'You have hit a temporary usage limit. Upgrade for more capacity, or try again shortly.',
      variant: 'error',
      duration: 8000,
      action: upgradeAction,
      secondaryAction: BYOK_TOAST_ACTION,
    }
  }

  if (includesAny(normalized, authMatchers)) {
    return {
      title: 'Please sign in again',
      description:
        'Stella needs you to reconnect your account before continuing.',
      variant: 'error',
      duration: 8000,
      action: signInAction,
      secondaryAction: BYOK_TOAST_ACTION,
    }
  }

  if (includesAny(normalized, modelRestrictionMatchers)) {
    return {
      title: 'Model not available on your plan',
      description:
        'Stella will use the recommended model for your current plan. Upgrade to switch models, or use your own provider key.',
      variant: 'error',
      duration: 8000,
      action: upgradeAction,
      secondaryAction: BYOK_TOAST_ACTION,
    }
  }

  if (includesAny(normalized, serviceUnavailableMatchers)) {
    return {
      title: 'Stella is having trouble connecting',
      description:
        'The model service is temporarily unavailable. Please try again in a moment.',
      variant: 'error',
      duration: 7000,
    }
  }

  if (includesAny(normalized, malformedRequestMatchers)) {
    return {
      title: 'Stella could not send that request',
      description:
        'Something about the request format was not accepted. Please try again.',
      variant: 'error',
      duration: 7000,
    }
  }

  return {
    title: 'Stella hit a snag',
    description:
      'Something went wrong while Stella was responding. Please try again.',
    variant: 'error',
  }
}
