/**
 * Surface a "this model isn't available on your plan" toast when a user on
 * a restricted tier (anonymous / free / go) submits a chat with a saved
 * non-default Stella model override AND Stella's own runtime is the
 * committed engine.
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
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";
import { router } from "@/router";
import {
  getModelRestrictionActionLabel,
  getModelRestrictionDescription,
  isRestrictedModelOverrideAudience,
  resolveBillingAudience,
  type ManagedModelAudience,
} from "@/global/billing/audience";
import { BYOK_TOAST_ACTION } from "@/global/billing/byok-action";
import {
  resolveTierRestrictedModelNotice,
  type NoticeRuntimeEngine,
} from "./tier-restricted-model-notice";
import { showToast } from "@/ui/toast";

type AuthSessionData =
  | {
      user?: {
        id?: string | null;
        email?: string | null;
        isAnonymous?: boolean | null;
      } | null;
    }
  | null
  | undefined;

type BillingStatusLite = {
  plan: "free" | "go" | "pro" | "plus" | "ultra";
  usage: {
    rollingUsedUsd: number;
    rollingLimitUsd: number;
    weeklyUsedUsd: number;
    weeklyLimitUsd: number;
    monthlyUsedUsd: number;
    monthlyLimitUsd: number;
  };
  authenticated?: boolean;
};

type LocalModelPreferences = {
  modelOverrides?: Record<string, string>;
  agentRuntimeEngine?: NoticeRuntimeEngine;
};

const buildToastDedupeKey = (
  audience: ManagedModelAudience,
  agent: string,
  model: string,
): string => `${audience}|${agent}|${model}`;

export function useTierRestrictedModelToast() {
  const session = useDesktopAuthSession();
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasConnectedAccount = Boolean(
    sessionData && user?.isAnonymous !== true,
  );

  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
  ) as BillingStatusLite | undefined;

  const audience = useMemo<ManagedModelAudience | null>(
    () => resolveBillingAudience({ hasConnectedAccount, billingStatus }),
    [billingStatus, hasConnectedAccount],
  );
  const audienceRef = useRef<ManagedModelAudience | null>(audience);
  audienceRef.current = audience;

  // Reset dedupe set whenever audience changes — re-upgrading should clear
  // prior toasts so a re-downgrade re-notifies.
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    seenRef.current = new Set();
  }, [audience]);

  return useCallback(async () => {
    const audience = audienceRef.current;
    if (!isRestrictedModelOverrideAudience(audience) || !audience) return;

    let preferences: LocalModelPreferences | null | undefined;
    try {
      preferences =
        await window.electronAPI?.system?.getLocalModelPreferences?.();
    } catch {
      return;
    }
    const notice = resolveTierRestrictedModelNotice({
      audience,
      agentRuntimeEngine: preferences?.agentRuntimeEngine,
      modelOverrides: preferences?.modelOverrides,
    });
    if (!notice) return;

    const dedupeKey = buildToastDedupeKey(audience, notice.agent, notice.model);
    if (seenRef.current.has(dedupeKey)) return;
    seenRef.current.add(dedupeKey);

    showToast({
      title: "Model not available on your plan",
      description: getModelRestrictionDescription({
        audience,
        modelLabel: notice.modelLabel,
        tense: "is",
      }),
      variant: "error",
      duration: 8000,
      action: {
        label: getModelRestrictionActionLabel(audience),
        onClick: () => {
          void router.navigate({ to: "/billing" });
        },
      },
      secondaryAction: BYOK_TOAST_ACTION,
    });
  }, []);
}
