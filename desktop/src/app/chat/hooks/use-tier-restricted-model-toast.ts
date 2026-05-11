/**
 * Surface a "this model isn't available on your plan" toast when a user on
 * a restricted tier (anonymous / free / go) submits a chat with a saved
 * non-default model override.
 *
 * The picker (`AgentModelPicker`) toasts at selection time, but a user
 * whose plan downgrades AFTER they picked a model would never see the
 * picker again before sending — this hook catches that case at submit
 * time. Deduped per (audience, agent, model) combo so it doesn't spam on
 * every send.
 *
 * Backend (`stella_provider/request.ts`) silently coerces the model in
 * either case — this is purely a UX notice.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/api'
import { useDesktopAuthSession } from '@/global/auth/services/auth-session'
import { router } from '@/router'
import {
  getModelRestrictionActionLabel,
  getModelRestrictionDescription,
  isRestrictedModelOverrideAudience,
  resolveBillingAudience,
  type ManagedModelAudience,
} from '@/shared/billing/audience'
import { showToast } from '@/ui/toast'

const ORCHESTRATOR_AND_GENERAL = ['orchestrator', 'general'] as const

type AuthSessionData =
  | {
      user?: {
        id?: string | null
        email?: string | null
        isAnonymous?: boolean | null
      } | null
    }
  | null
  | undefined

type BillingStatusLite = {
  plan: 'free' | 'go' | 'pro' | 'plus' | 'ultra'
  usage: {
    rollingUsedUsd: number
    rollingLimitUsd: number
    weeklyUsedUsd: number
    weeklyLimitUsd: number
    monthlyUsedUsd: number
    monthlyLimitUsd: number
  }
}

type LocalModelPreferences = {
  modelOverrides?: Record<string, string>
}

const buildToastDedupeKey = (
  audience: ManagedModelAudience,
  agent: string,
  model: string,
): string => `${audience}|${agent}|${model}`

const getModelToastLabel = (model: string): string => {
  const withoutStellaPrefix = model.startsWith('stella/')
    ? model.slice('stella/'.length)
    : model
  const lastSlash = withoutStellaPrefix.lastIndexOf('/')
  const displayId =
    lastSlash >= 0 ? withoutStellaPrefix.slice(lastSlash + 1) : withoutStellaPrefix
  return displayId || 'That model'
}

export function useTierRestrictedModelToast() {
  const session = useDesktopAuthSession()
  const sessionData = session.data as AuthSessionData
  const user = sessionData?.user ?? null
  const hasConnectedAccount = Boolean(
    sessionData && user?.isAnonymous !== true,
  )

  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : 'skip',
  ) as BillingStatusLite | undefined

  const audience = useMemo<ManagedModelAudience | null>(
    () => resolveBillingAudience({ hasConnectedAccount, billingStatus }),
    [billingStatus, hasConnectedAccount],
  )
  const audienceRef = useRef<ManagedModelAudience | null>(audience)
  audienceRef.current = audience

  // Reset dedupe set whenever audience changes — re-upgrading should clear
  // prior toasts so a re-downgrade re-notifies.
  const seenRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    seenRef.current = new Set()
  }, [audience])

  return useCallback(async () => {
    const audience = audienceRef.current
    if (!isRestrictedModelOverrideAudience(audience) || !audience) return

    let preferences: LocalModelPreferences | null | undefined
    try {
      preferences =
        await window.electronAPI?.system?.getLocalModelPreferences?.()
    } catch {
      return
    }
    const overrides = preferences?.modelOverrides ?? {}

    for (const agent of ORCHESTRATOR_AND_GENERAL) {
      const override = overrides[agent]?.trim()
      if (!override) continue
      const dedupeKey = buildToastDedupeKey(audience, agent, override)
      if (seenRef.current.has(dedupeKey)) continue
      seenRef.current.add(dedupeKey)

      const modelLabel = getModelToastLabel(override)
      showToast({
        title: 'Model not available on your plan',
        description: getModelRestrictionDescription({
          audience,
          modelLabel,
          tense: 'is',
        }),
        variant: 'error',
        duration: 8000,
        action: {
          label: getModelRestrictionActionLabel(audience),
          onClick: () => {
            void router.navigate({ to: '/billing' })
          },
        },
      })
      // One toast per send is enough — don't stack two if both orchestrator
      // and general have non-default overrides.
      return
    }
  }, [])
}
