import {
  BYOK_TOAST_ACTION,
  OPEN_MODEL_PICKER_EVENT,
} from '@/global/billing/byok-action'
import type { ToastOptions } from '@/ui/toast'
import { detectLlmRouteFailureKind } from '../../../../../runtime/ai/llm-route-failure.js'
import {
  classifyStellaProviderError,
  isStellaLimitOrAuthClassification,
} from './stella-provider-error-classifier'

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

/**
 * True when a stopped run names a limit or authentication problem worth
 * surfacing. Ordinary user-initiated cancellations remain silent.
 */
export const isStellaLimitOrAuthReason = (
  reason: string | null | undefined,
): boolean =>
  isStellaLimitOrAuthClassification(classifyStellaProviderError(reason))

export const resolveStellaProviderErrorToast = (
  reason: string | null | undefined,
): ToastOptions => {
  const classification = classifyStellaProviderError(reason)
  const message = classification.message

  // Runtime route failures carry a stable marker, so these keep their exact
  // actions even if the human-readable runtime prose changes.
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

  switch (classification.kind) {
    case 'claude-code-login':
      return {
        title: 'Claude Code needs login',
        description:
          'Open Terminal, run claude, then use /login. Retry in Stella after Claude Code confirms you are signed in.',
        variant: 'error',
        duration: 10000,
      }
    case 'sign-in-required':
      return {
        title: 'Sign in to keep using Stella',
        description:
          "You've used your free Stella previews. Sign in to keep going, or use your own provider key.",
        variant: 'error',
        duration: 8000,
        action: signInAction,
        secondaryAction: BYOK_TOAST_ACTION,
      }
    case 'chatgpt-usage-limit':
      return {
        title: 'ChatGPT usage limit reached',
        description:
          'Your ChatGPT Pro usage limit has been reached. Choose another model now, or try again after it resets.',
        variant: 'error',
        duration: 10000,
        action: chooseModelAction,
        secondaryAction: BYOK_TOAST_ACTION,
      }
    case 'billing':
      return {
        title: 'Stella needs more room',
        description:
          'You have reached the limit for your current plan. Upgrade to keep going, or wait until usage resets.',
        variant: 'error',
        duration: 8000,
        action: upgradeAction,
        secondaryAction: BYOK_TOAST_ACTION,
      }
    case 'rate-limit':
      return {
        title: 'Model usage limit reached',
        description:
          'This model has reached a temporary usage limit. Choose another model or try again shortly.',
        variant: 'error',
        duration: 8000,
        action: chooseModelAction,
        secondaryAction: BYOK_TOAST_ACTION,
      }
    case 'account-auth':
      return {
        title: 'Please sign in again',
        description:
          'Stella needs you to reconnect your account before continuing.',
        variant: 'error',
        duration: 8000,
        action: signInAction,
        secondaryAction: BYOK_TOAST_ACTION,
      }
    case 'provider-access':
      return {
        title: 'Provider access needed',
        description:
          'Reconnect the selected provider or choose another model to continue.',
        variant: 'error',
        duration: 9000,
        action: chooseModelAction,
        secondaryAction: BYOK_TOAST_ACTION,
      }
    case 'model-restriction':
      return {
        title: 'Model not available on your plan',
        description:
          'Stella will use the recommended model for your current plan. Upgrade to switch models, or use your own provider key.',
        variant: 'error',
        duration: 8000,
        action: upgradeAction,
        secondaryAction: BYOK_TOAST_ACTION,
      }
    case 'context-limit':
      return {
        title: 'This chat is too long',
        description:
          'Start a new chat or remove some attachments, then try again.',
        variant: 'error',
        duration: 9000,
      }
    case 'content-blocked':
      return {
        title: 'The model could not answer that',
        description:
          'The model blocked this request. Try rewording it or choose another model.',
        variant: 'error',
        duration: 9000,
        action: chooseModelAction,
      }
    case 'timeout':
      return {
        title: 'The response timed out',
        description: 'The model took too long to respond. Please try again.',
        variant: 'error',
        duration: 8000,
      }
    case 'network':
      return {
        title: 'Stella could not connect',
        description: 'Check your internet connection and try again.',
        variant: 'error',
        duration: 8000,
      }
    case 'service-unavailable':
      return {
        title: 'Stella is having trouble connecting',
        description:
          'The model service is temporarily unavailable. Please try again in a moment.',
        variant: 'error',
        duration: 7000,
      }
    case 'malformed-request':
      return {
        title: 'Stella could not send that request',
        description:
          'Something about the request format was not accepted. Please try again.',
        variant: 'error',
        duration: 7000,
      }
    case 'unknown':
      return {
        title: 'Stella could not finish',
        description:
          classification.detail ??
          'Stella could not finish this response. Please try again.',
        variant: 'error',
        duration: 10000,
      }
  }
}
