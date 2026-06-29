import {
  BYOK_TOAST_ACTION,
  OPEN_MODEL_PICKER_EVENT,
} from '@/global/billing/byok-action'
import { detectLlmRouteFailureKind } from '../../../../../runtime/ai/llm-route-failure.js'
import type { ToastOptions } from '@/ui/toast'

const normalizeErrorText = (value: string | null | undefined): string =>
  (value ?? '').trim()

const openBilling = () => {
  void import('@/router').then(({ router }) => {
    void router.navigate({ to: '/billing' })
  })
}

const openSignInDialog = () => {
  void import('@/router').then(({ router }) => {
    void router.navigate({
      to: '.',
      search: (prev: { dialog?: 'auth' | 'connect' }) => ({
        ...prev,
        dialog: 'auth' as const,
      }),
    })
  })
}

const openModelPicker = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(OPEN_MODEL_PICKER_EVENT))
}

const chooseModelAction = {
  label: 'Choose model',
  onClick: openModelPicker,
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

/**
 * True when an error reason is a Stella usage/limit/auth condition that needs a
 * sign-in / upgrade CTA (anon cap reached, plan limit, rate limit, expired
 * session). Used to decide whether a *stopped* run or a *failed* start is a
 * "you've run out / need to sign in" situation versus a transient hiccup — so
 * we can surface the right actionable toast in both spots, not just on the next
 * send.
 */
export const isStellaLimitOrAuthReason = (
  reason: string | null | undefined,
): boolean => {
  const normalized = normalizeErrorText(reason).toLowerCase()
  if (!normalized) return false
  return (
    includesAny(normalized, signInRequiredMatchers) ||
    includesAny(normalized, billingMatchers) ||
    includesAny(normalized, rateLimitMatchers) ||
    includesAny(normalized, authMatchers)
  )
}

export const resolveStellaProviderErrorToast = (
  reason: string | null | undefined,
): ToastOptions => {
  const message = normalizeErrorText(reason)
  const normalized = message.toLowerCase()

  // Route-resolution failures carry a stable marker from the runtime resolver
  // (`runtime/ai/llm-route-failure.ts`), so we map them by kind rather than by
  // matching their human-readable prose.
  const routeFailureKind = detectLlmRouteFailureKind(message)
  if (routeFailureKind === 'missing-credential') {
    return {
      title: 'Provider key needed',
      description:
        'Stella could not use your selected model because its API key is missing or unreadable. Add or re-check it in Settings → Model, or pick another model.',
      variant: 'error',
      duration: 8000,
      action: chooseModelAction,
      secondaryAction: BYOK_TOAST_ACTION,
    }
  }
  if (
    routeFailureKind === 'unknown-model' ||
    routeFailureKind === 'unsupported-provider'
  ) {
    return {
      title: 'Model unavailable',
      description:
        'Stella could not use your selected model. Choose a different model to continue.',
      variant: 'error',
      duration: 8000,
      action: chooseModelAction,
    }
  }
  if (routeFailureKind === 'no-stella-route') {
    return {
      title: 'No model available',
      description:
        'Sign in to use Stella, or add your own provider key to keep going.',
      variant: 'error',
      duration: 8000,
      action: signInAction,
      secondaryAction: BYOK_TOAST_ACTION,
    }
  }

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
