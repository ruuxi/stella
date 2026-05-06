import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  consumeBillingCheckoutCompletionMarker,
  withCheckoutMarker,
} from "@/global/settings/lib/billing-checkout";
import { openExternalUrl } from "@/platform/electron/open-external";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { Button } from "@/ui/button";
import { useI18n } from "@/shared/i18n";

type BillingPlan = "free" | "go" | "pro" | "plus" | "ultra";
type PaidBillingPlan = Exclude<BillingPlan, "free">;

type BillingPlanConfig = {
  label: string;
  monthlyPriceCents: number;
  rollingLimitUsd: number;
  rollingWindowHours: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  tokensPerMinute: number;
};

type BillingUsage = {
  rollingUsedUsd: number;
  rollingLimitUsd: number;
  weeklyUsedUsd: number;
  weeklyLimitUsd: number;
  monthlyUsedUsd: number;
  monthlyLimitUsd: number;
};

type BillingStatus = {
  authenticated: boolean;
  isAnonymous: boolean;
  plan: BillingPlan;
  subscriptionStatus: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  usage: BillingUsage;
  plans: Record<BillingPlan, BillingPlanConfig>;
};

type EmbeddedCheckoutSessionPayload = {
  publishableKey: string;
  clientSecret: string;
  sessionId: string;
};

type BillingPortalSessionPayload = {
  url: string;
};

const PLAN_ORDER: BillingPlan[] = ["free", "go", "pro", "plus", "ultra"];

// Public-facing display catalog. Mirrors backend/convex/lib/billing_plans.ts so
// the Plans grid is always renderable even if the live subscription-status
// query hasn't resolved yet (e.g. while Convex's auth handshake is still in
// flight). Stripe Checkout uses the backend's STRIPE_PRICE_* IDs as the actual
// source of pricing, so any drift here would be a visible bug rather than a
// silent overcharge.
const STATIC_PLAN_DISPLAY: Record<
  BillingPlan,
  { label: string; monthlyPriceCents: number }
> = {
  free: { label: "Free", monthlyPriceCents: 0 },
  go: { label: "Go", monthlyPriceCents: 2_000 },
  pro: { label: "Pro", monthlyPriceCents: 6_000 },
  plus: { label: "Plus", monthlyPriceCents: 10_000 },
  ultra: { label: "Ultra", monthlyPriceCents: 20_000 },
};

const PLAN_DESCRIPTION_KEYS: Record<
  BillingPlan,
  { taglineKey: string; featuresKey: string }
> = {
  free: {
    taglineKey: "billing.plans.free.tagline",
    featuresKey: "billing.plans.free.features",
  },
  go: {
    taglineKey: "billing.plans.go.tagline",
    featuresKey: "billing.plans.go.features",
  },
  pro: {
    taglineKey: "billing.plans.pro.tagline",
    featuresKey: "billing.plans.pro.features",
  },
  plus: {
    taglineKey: "billing.plans.plus.tagline",
    featuresKey: "billing.plans.plus.features",
  },
  ultra: {
    taglineKey: "billing.plans.ultra.tagline",
    featuresKey: "billing.plans.ultra.features",
  },
};

const buildCurrencyFormatter = (
  locale: string,
  options: Intl.NumberFormatOptions,
) => {
  // Currency stays USD until per-currency Stripe pricing exists, but
  // grouping/decimal/sign rules track the active locale. The locale
  // never affects the underlying charge — Stripe always bills in the
  // configured price's currency.
  return new Intl.NumberFormat(locale, { currency: "USD", ...options });
};

const stripePromiseByKey = new Map<string, Promise<Stripe | null>>();

const getStripePromise = (publishableKey: string) => {
  const existing = stripePromiseByKey.get(publishableKey);
  if (existing) {
    return existing;
  }

  const created = loadStripe(publishableKey);
  stripePromiseByKey.set(publishableKey, created);
  return created;
};

const toSafeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const getSettingsErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const resolveCheckoutReturnUrl = () => {
  const configuredCandidates = [
    import.meta.env.VITE_BILLING_RETURN_URL as string | undefined,
    readConfiguredConvexSiteUrl(
      import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
    ) ?? undefined,
  ];

  for (const candidate of configuredCandidates) {
    const value = candidate?.trim();
    if (!value) {
      continue;
    }
    try {
      return withCheckoutMarker(value);
    } catch {
      continue;
    }
  }

  throw new Error(
    "Billing return URL is not configured. Set VITE_BILLING_RETURN_URL or VITE_CONVEX_SITE_URL.",
  );
};

const toUsagePercent = (usedUsd: number, limitUsd: number) => {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    return 0;
  }
  if (!Number.isFinite(usedUsd) || usedUsd <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (usedUsd / limitUsd) * 100));
};

export function BillingTab() {
  const { hasConnectedAccount } = useAuthSessionState();
  const { locale, t, tArray } = useI18n();
  const priceFormatter = useMemo(
    () =>
      buildCurrencyFormatter(locale, {
        style: "currency",
        maximumFractionDigits: 0,
      }),
    [locale],
  );
  const usdFormatter = useMemo(
    () =>
      buildCurrencyFormatter(locale, {
        style: "currency",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [locale],
  );
  const navigate = useNavigate();
  const [billingNowMs, setBillingNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setBillingNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // The catalog (and the user's free-tier defaults) is safe to read without a
  // connected account; the backend handles both the unauthenticated and
  // anonymous-identity paths and returns the plan list either way. Skipping
  // the query when signed-out used to leave the Plans grid blank, which read
  // as "you must sign in to see the plans" — exactly what we don't want.
  //
  // One-shot rather than a live subscription: the existing `setInterval`
  // already deliberately re-fires every 60s by bumping `billingNowMs`
  // (which busts backend cache for the rolling-window snapshot), so a
  // standing WebSocket subscription was just polling-on-top-of-pushing.
  const billingStatus = useConvexOneShot(api.billing.getSubscriptionStatus, {
    now: billingNowMs,
  }) as BillingStatus | undefined;

  const openAuthDialog = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown> | undefined) => ({
        ...(prev ?? {}),
        dialog: "auth" as const,
      }),
    });
  }, [navigate]);
  const createEmbeddedCheckoutSession = useAction(
    api.billing.createEmbeddedCheckoutSession,
  );
  const createBillingPortalSession = useAction(
    api.billing.createBillingPortalSession,
  );

  const [checkoutSession, setCheckoutSession] =
    useState<EmbeddedCheckoutSessionPayload | null>(null);
  const [isStartingCheckoutPlan, setIsStartingCheckoutPlan] =
    useState<PaidBillingPlan | null>(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);

  const planCatalog = billingStatus?.plans;

  const currentPlan = billingStatus?.plan ?? "free";
  const usage = billingStatus?.usage;
  const isLoadingStatus = billingStatus === undefined;

  // Resolve display info per plan: prefer the live catalog when it's loaded
  // (so backend overrides like custom labels propagate), otherwise fall back
  // to the static display catalog. This guarantees the grid never blanks.
  const getPlanDisplay = (plan: BillingPlan) => {
    const live = planCatalog?.[plan];
    const fallback = STATIC_PLAN_DISPLAY[plan];
    return {
      label: live?.label ?? fallback.label,
      monthlyPriceCents: live?.monthlyPriceCents ?? fallback.monthlyPriceCents,
    };
  };

  const openExternal = useCallback((url: string) => {
    openExternalUrl(url);
  }, []);

  useEffect(() => {
    if (!consumeBillingCheckoutCompletionMarker()) {
      return;
    }

    setCheckoutSession(null);
    setBillingError(null);
    setCheckoutNotice(
      "Checkout complete. Stella is syncing your billing status now.",
    );
  }, []);

  const handleCheckoutComplete = useCallback(() => {
    setCheckoutSession(null);
    setCheckoutNotice(
      "Payment complete. Your updated plan will appear shortly.",
    );
  }, []);

  const handleStartCheckout = useCallback(
    async (plan: PaidBillingPlan) => {
      if (!hasConnectedAccount) {
        // Plans are visible to everyone, but subscribing requires a real
        // account. Take the user straight to the sign-in dialog instead of
        // showing an inline error they can't act on.
        openAuthDialog();
        return;
      }

      setBillingError(null);
      setCheckoutNotice(null);
      setIsStartingCheckoutPlan(plan);

      try {
        const returnUrl = resolveCheckoutReturnUrl();
        const session = (await createEmbeddedCheckoutSession({
          plan,
          returnUrl,
        })) as EmbeddedCheckoutSessionPayload;
        const publishableKey = toSafeString(session?.publishableKey);
        const clientSecret = toSafeString(session?.clientSecret);
        const sessionId = toSafeString(session?.sessionId);
        if (!publishableKey || !clientSecret || !sessionId) {
          throw new Error("Invalid checkout session response.");
        }

        setCheckoutSession({
          publishableKey,
          clientSecret,
          sessionId,
        });
      } catch (error) {
        setBillingError(
          getSettingsErrorMessage(error, "Unable to start checkout right now."),
        );
      } finally {
        setIsStartingCheckoutPlan(null);
      }
    },
    [createEmbeddedCheckoutSession, hasConnectedAccount, openAuthDialog],
  );

  const handleOpenBillingPortal = useCallback(async () => {
    if (!hasConnectedAccount) {
      setBillingError("Sign in with an account before managing billing.");
      return;
    }

    setBillingError(null);
    setCheckoutNotice(null);
    setIsOpeningPortal(true);

    try {
      const returnUrl = resolveCheckoutReturnUrl();
      const session = (await createBillingPortalSession({
        returnUrl,
      })) as BillingPortalSessionPayload;
      const billingPortalUrl = toSafeString(session?.url);
      if (!billingPortalUrl) {
        throw new Error("Missing billing portal URL.");
      }
      openExternal(billingPortalUrl);
    } catch (error) {
      setBillingError(
        getSettingsErrorMessage(
          error,
          "Unable to open billing management right now.",
        ),
      );
    } finally {
      setIsOpeningPortal(false);
    }
  }, [createBillingPortalSession, hasConnectedAccount, openExternal]);

  const checkoutOptions = useMemo(
    () =>
      checkoutSession
        ? {
            clientSecret: checkoutSession.clientSecret,
            onComplete: handleCheckoutComplete,
          }
        : null,
    [checkoutSession, handleCheckoutComplete],
  );

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">Billing</h3>
          <Button
            type="button"
            variant="ghost"
            className="settings-btn"
            onClick={() => void handleOpenBillingPortal()}
            disabled={
              !hasConnectedAccount ||
              isOpeningPortal ||
              isLoadingStatus ||
              !planCatalog ||
              currentPlan === "free"
            }
          >
            {isOpeningPortal ? "Opening..." : "Manage Billing"}
          </Button>
        </div>
        {!hasConnectedAccount ? (
          <p className="settings-card-desc">
            Browse the plans below. Sign in with an account when you're ready to
            subscribe or manage payment methods.
          </p>
        ) : null}
        {billingError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {billingError}
          </p>
        ) : null}
        {checkoutNotice ? (
          <p className="settings-card-desc">{checkoutNotice}</p>
        ) : null}

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Current plan</div>
            <div className="settings-row-sublabel">
              {isLoadingStatus
                ? "Loading billing status..."
                : `${getPlanDisplay(currentPlan).label} plan`}
            </div>
          </div>
          <div className="settings-row-control">
            <span className="settings-billing-current-plan-pill">
              {getPlanDisplay(currentPlan).label}
            </span>
          </div>
        </div>

        {usage && planCatalog ? (
          <div className="settings-row settings-row--billing-usage">
            <div className="settings-row-info">
              <div className="settings-row-label">Usage this month</div>
              <div className="settings-row-sublabel">
                {usdFormatter.format(usage.monthlyUsedUsd)} /{" "}
                {usdFormatter.format(usage.monthlyLimitUsd)}
              </div>
            </div>
            <div className="settings-row-control settings-row-control--billing-meter">
              <div className="settings-billing-meter-track">
                <div
                  className="settings-billing-meter-fill"
                  style={{
                    width: `${toUsagePercent(usage.monthlyUsedUsd, usage.monthlyLimitUsd)}%`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <h3 className="settings-card-title">Plans</h3>

        <div className="settings-billing-plan-grid">
          {PLAN_ORDER.map((plan) => {
            const display = getPlanDisplay(plan);
            const isCurrentPlan = plan === currentPlan;
            const isPaidPlan = plan !== "free";
            const isStartingThisPlan = isStartingCheckoutPlan === plan;
            const planKeys = PLAN_DESCRIPTION_KEYS[plan];
            const tagline = t(planKeys.taglineKey);
            const features = tArray(planKeys.featuresKey);

            return (
              <div
                key={plan}
                className="settings-billing-plan-card"
                data-active={isCurrentPlan || undefined}
              >
                <div className="settings-billing-plan-name">
                  {display.label}
                </div>
                <div className="settings-billing-plan-price">
                  {display.monthlyPriceCents <= 0
                    ? "Free"
                    : `${priceFormatter.format(display.monthlyPriceCents / 100)}/mo`}
                </div>
                <div className="settings-billing-plan-tagline">{tagline}</div>
                <ul className="settings-billing-plan-features">
                  {features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {isPaidPlan ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="settings-btn settings-btn--primary settings-billing-plan-cta"
                    onClick={() =>
                      void handleStartCheckout(plan as PaidBillingPlan)
                    }
                    disabled={isCurrentPlan || isStartingCheckoutPlan !== null}
                  >
                    {isCurrentPlan
                      ? "Current Plan"
                      : isStartingThisPlan
                        ? "Opening Checkout..."
                        : !hasConnectedAccount
                          ? `Sign in to choose ${display.label}`
                          : `Choose ${display.label}`}
                  </Button>
                ) : (
                  <div className="settings-billing-plan-included">Included</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {checkoutSession && checkoutOptions ? (
        <div className="settings-card">
          <div className="settings-card-header">
            <h3 className="settings-card-title">Checkout</h3>
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => setCheckoutSession(null)}
            >
              Close Checkout
            </Button>
          </div>
          <p className="settings-card-desc">
            Complete payment below. Stella will update your plan automatically
            once confirmed.
          </p>
          <div className="settings-billing-checkout-shell">
            <EmbeddedCheckoutProvider
              stripe={getStripePromise(checkoutSession.publishableKey)}
              options={checkoutOptions}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        </div>
      ) : null}
    </div>
  );
}
