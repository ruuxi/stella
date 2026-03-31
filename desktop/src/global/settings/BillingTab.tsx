import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  consumeBillingCheckoutCompletionMarker,
  withCheckoutMarker,
} from "@/global/settings/lib/billing-checkout";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { Button } from "@/ui/button";

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

const PLAN_DESCRIPTIONS: Record<BillingPlan, { tagline: string; features: string[] }> = {
  free: {
    tagline: "Get started with Stella",
    features: ["Basic chat & assistance", "Limited daily usage"],
  },
  go: {
    tagline: "For everyday personal use",
    features: ["More conversations per day", "Browser automation", "Voice conversations"],
  },
  pro: {
    tagline: "For power users",
    features: ["3x the usage of Go", "Priority response times", "All automation features"],
  },
  plus: {
    tagline: "For professionals",
    features: ["Heavy daily usage", "Advanced agent workflows", "Priority support"],
  },
  ultra: {
    tagline: "Unlimited productivity",
    features: ["Maximum usage limits", "Fastest response times", "Everything in Plus"],
  },
};

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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
  const [billingNowMs, setBillingNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setBillingNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const billingStatus = useQuery(api.billing.getSubscriptionStatus, {
    now: billingNowMs,
  }) as BillingStatus | undefined;
  const createEmbeddedCheckoutSession = useAction(
    api.billing.createEmbeddedCheckoutSession,
  );
  const createBillingPortalSession = useAction(
    api.billing.createBillingPortalSession,
  );

  const [checkoutSession, setCheckoutSession] = useState<EmbeddedCheckoutSessionPayload | null>(null);
  const [isStartingCheckoutPlan, setIsStartingCheckoutPlan] = useState<PaidBillingPlan | null>(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);

  const planCatalog = billingStatus?.plans;

  const currentPlan = billingStatus?.plan ?? "free";
  const usage = billingStatus?.usage;
  const isLoadingStatus = billingStatus === undefined;

  const openExternal = useCallback((url: string) => {
    if (window.electronAPI?.system.openExternal) {
      window.electronAPI.system.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  useEffect(() => {
    if (!consumeBillingCheckoutCompletionMarker()) {
      return;
    }

    setCheckoutSession(null);
    setBillingError(null);
    setCheckoutNotice("Checkout complete. Stella is syncing your billing status now.");
  }, []);

  const handleCheckoutComplete = useCallback(() => {
    setCheckoutSession(null);
    setCheckoutNotice("Payment complete. Your updated plan will appear shortly.");
  }, []);

  const handleStartCheckout = useCallback(
    async (plan: PaidBillingPlan) => {
      if (!hasConnectedAccount) {
        setBillingError("Sign in with an account before subscribing.");
        return;
      }

      setBillingError(null);
      setCheckoutNotice(null);
      setIsStartingCheckoutPlan(plan);

      try {
        const returnUrl = resolveCheckoutReturnUrl();
        const session =
          (await createEmbeddedCheckoutSession({
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
    [createEmbeddedCheckoutSession, hasConnectedAccount],
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
        getSettingsErrorMessage(error, "Unable to open billing management right now."),
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
              !hasConnectedAccount
              || isOpeningPortal
              || isLoadingStatus
              || !planCatalog
              || currentPlan === "free"
            }
          >
            {isOpeningPortal ? "Opening..." : "Manage Billing"}
          </Button>
        </div>
        {!hasConnectedAccount ? (
          <p className="settings-card-desc">
            Sign in with an account to subscribe or manage payment methods.
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
              {isLoadingStatus || !planCatalog
                ? "Loading billing status..."
                : `${planCatalog[currentPlan].label} plan`}
            </div>
          </div>
          <div className="settings-row-control">
            <span className="settings-billing-current-plan-pill">
              {planCatalog?.[currentPlan]?.label ?? "..."}
            </span>
          </div>
        </div>

        {usage && planCatalog ? (
          <div className="settings-row settings-row--billing-usage">
            <div className="settings-row-info">
              <div className="settings-row-label">Usage this month</div>
              <div className="settings-row-sublabel">
                {usdFormatter.format(usage.monthlyUsedUsd)} / {usdFormatter.format(usage.monthlyLimitUsd)}
              </div>
            </div>
            <div className="settings-row-control settings-row-control--billing-meter">
              <div className="settings-billing-meter-track">
                <div
                  className="settings-billing-meter-fill"
                  style={{ width: `${toUsagePercent(usage.monthlyUsedUsd, usage.monthlyLimitUsd)}%` }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <h3 className="settings-card-title">Plans</h3>

        {planCatalog ? (
          <div className="settings-billing-plan-grid">
            {PLAN_ORDER.map((plan) => {
              const config = planCatalog[plan];
              if (!config) return null;
              const isCurrentPlan = plan === currentPlan;
              const isPaidPlan = plan !== "free";
              const isStartingThisPlan = isStartingCheckoutPlan === plan;
              const desc = PLAN_DESCRIPTIONS[plan];

              return (
                <div
                  key={plan}
                  className="settings-billing-plan-card"
                  data-active={isCurrentPlan || undefined}
                >
                  <div className="settings-billing-plan-name">{config.label}</div>
                  <div className="settings-billing-plan-price">
                    {config.monthlyPriceCents <= 0
                      ? "Free"
                      : `${priceFormatter.format(config.monthlyPriceCents / 100)}/mo`}
                  </div>
                  <div className="settings-billing-plan-tagline">{desc.tagline}</div>
                  <ul className="settings-billing-plan-features">
                    {desc.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {isPaidPlan ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="settings-btn settings-btn--primary settings-billing-plan-cta"
                      onClick={() => void handleStartCheckout(plan as PaidBillingPlan)}
                      disabled={
                        isCurrentPlan
                        || !hasConnectedAccount
                        || isStartingCheckoutPlan !== null
                      }
                    >
                      {isCurrentPlan
                        ? "Current Plan"
                        : isStartingThisPlan
                          ? "Opening Checkout..."
                          : `Choose ${config.label}`}
                    </Button>
                  ) : (
                    <div className="settings-billing-plan-included">Included</div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="settings-card-desc">Loading plan options...</p>
        )}
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
            Complete payment below. Stella will update your plan automatically once confirmed.
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

export default BillingTab;
