/**
 * Shared toast for "media generation requires a Stella subscription"
 * rejections coming back from Stella-paid media surfaces (image/video
 * via `/api/media/v1/generate`, music via `/api/music/stream`, future
 * emoji-pack generation, …).
 *
 * Backend marker: `lib/managed_billing.assertPaidMediaTier` and the
 * `isPaidMediaTier` checks in `http_routes/media.ts` +
 * `http_routes/music.ts`. Either path returns a 402 with this message
 * or throws a `PAID_PLAN_REQUIRED` ConvexError carrying it — both
 * surface to the renderer as a thrown Error whose message contains the
 * substring matched here.
 */
import { router } from '@/router'
import { showToast } from '@/ui/toast'
import { BYOK_TOAST_ACTION } from './byok-action'

const PAID_TIER_MATCHERS = [
  'requires a stella subscription',
  'paid_plan_required',
] as const

const matchesPaidTierError = (message: string): boolean => {
  const normalized = message.toLowerCase()
  return PAID_TIER_MATCHERS.some((matcher) => normalized.includes(matcher))
}

const extractErrorMessage = (error: unknown): string => {
  if (!error) return ''
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && 'message' in (error as Record<string, unknown>)) {
    const value = (error as { message?: unknown }).message
    return typeof value === 'string' ? value : ''
  }
  return ''
}

/** Unwrap JSON error bodies from Stella media HTTP responses. */
export const parseMediaApiErrorMessage = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (!trimmed.startsWith('{')) return trimmed
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown
      message?: unknown
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim()
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim()
    }
  } catch {
    // fall through
  }
  return trimmed
}

const readableMediaErrorMessage = (error: unknown): string => {
  const message = extractErrorMessage(error)
  return message ? parseMediaApiErrorMessage(message) : ''
}

/**
 * If `error` looks like a Stella paid-tier rejection, fire the upgrade
 * toast and return true.
 */
export const maybeShowPaidMediaTierToast = (error: unknown): boolean => {
  const message = readableMediaErrorMessage(error)
  if (!message || !matchesPaidTierError(message)) return false
  showToast({
    title: 'Upgrade to use media generation',
    description:
      'Stella media generation (images, video, music) is included on paid plans.',
    variant: 'error',
    duration: 8000,
    action: {
      label: 'Upgrade',
      onClick: () => {
        void router.navigate({ to: '/billing' })
      },
    },
    secondaryAction: BYOK_TOAST_ACTION,
  })
  return true
}

/** Toast-only error surface for right-sidebar Media tab and `/api/media` callers. */
export const notifyMediaGenerationError = (error: unknown): void => {
  if (maybeShowPaidMediaTierToast(error)) return
  const message = readableMediaErrorMessage(error)
  if (!message) return
  showToast({
    title: message,
    variant: 'error',
    duration: 8000,
  })
}
