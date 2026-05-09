import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAction } from "convex/react";
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Dialog } from "@/ui/dialog";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  consumeBillingCheckoutCompletionMarker,
  withCheckoutMarker,
} from "@/global/settings/lib/billing-checkout";
import { openExternalUrl } from "@/platform/electron/open-external";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { useI18n } from "@/shared/i18n";
import "./billing.css";

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

const RECOMMENDED_PLAN: BillingPlan = "pro";

// Public-facing display catalog. Mirrors backend/convex/lib/billing_plans.ts so
// the Plans grid renders even before the live subscription-status query
// resolves. Stripe Checkout uses the backend's STRIPE_PRICE_* IDs as the
// actual source of pricing, so any drift here would surface as a visible bug
// rather than a silent overcharge.
const STATIC_PLAN_DISPLAY: Record<
  BillingPlan,
  { label: string; monthlyPriceCents: number; estimatedUsageUsd: number }
> = {
  free: { label: "Free", monthlyPriceCents: 0, estimatedUsageUsd: 4 },
  // Estimated usage = price / 0.7 utilization rate (matches backend default).
  go: { label: "Go", monthlyPriceCents: 2_000, estimatedUsageUsd: 28.57 },
  pro: { label: "Pro", monthlyPriceCents: 6_000, estimatedUsageUsd: 85.71 },
  plus: { label: "Plus", monthlyPriceCents: 10_000, estimatedUsageUsd: 142.86 },
  ultra: { label: "Ultra", monthlyPriceCents: 20_000, estimatedUsageUsd: 285.71 },
};

const SHARED_FEATURES: readonly string[] = [
  "Unlimited chat with Stella",
  "Bring any model — local or cloud",
  "Browser, voice & screen control",
  "Image, video, audio & 3D generation",
  "All apps, integrations & connectors",
  "Self-modifying personalization",
  "Priority response times",
  "Files stay on your device",
];

const buildCurrencyFormatter = (
  locale: string,
  options: Intl.NumberFormatOptions,
) => new Intl.NumberFormat(locale, { currency: "USD", ...options });

const stripePromiseByKey = new Map<string, Promise<Stripe | null>>();

const getStripePromise = (publishableKey: string) => {
  const existing = stripePromiseByKey.get(publishableKey);
  if (existing) return existing;
  const created = loadStripe(publishableKey);
  stripePromiseByKey.set(publishableKey, created);
  return created;
};

const toSafeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const resolveCheckoutReturnUrl = () => {
  const candidates = [
    import.meta.env.VITE_BILLING_RETURN_URL as string | undefined,
    readConfiguredConvexSiteUrl(
      import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
    ) ?? undefined,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
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
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) return 0;
  if (!Number.isFinite(usedUsd) || usedUsd <= 0) return 0;
  return Math.min(100, Math.max(0, (usedUsd / limitUsd) * 100));
};

export function BillingScreen() {
  const { hasConnectedAccount } = useAuthSessionState();
  const { locale } = useI18n();
  const navigate = useNavigate();

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

  const [billingNowMs, setBillingNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setBillingNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // The catalog is safe to read without a connected account — backend
  // returns a default for unauthenticated callers. One-shot rather than a
  // live subscription because we already deliberately re-fire every 60s
  // by bumping `billingNowMs` (busts the rolling-window cache).
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
  const [pendingPlan, setPendingPlan] = useState<PaidBillingPlan | null>(null);
  const [isStartingCheckoutPlan, setIsStartingCheckoutPlan] =
    useState<PaidBillingPlan | null>(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);

  const planCatalog = billingStatus?.plans;
  const currentPlan = billingStatus?.plan ?? "free";
  const usage = billingStatus?.usage;
  const isLoadingStatus = billingStatus === undefined;

  const getPlanDisplay = useCallback(
    (plan: BillingPlan) => {
      const live = planCatalog?.[plan];
      const fallback = STATIC_PLAN_DISPLAY[plan];
      return {
        label: live?.label ?? fallback.label,
        monthlyPriceCents: live?.monthlyPriceCents ?? fallback.monthlyPriceCents,
        monthlyUsageUsd:
          live?.monthlyLimitUsd ?? fallback.estimatedUsageUsd,
      };
    },
    [planCatalog],
  );

  const openExternal = useCallback((url: string) => {
    openExternalUrl(url);
  }, []);

  useEffect(() => {
    if (!consumeBillingCheckoutCompletionMarker()) return;
    setCheckoutSession(null);
    setPendingPlan(null);
    setBillingError(null);
    setCheckoutNotice(
      "Checkout complete. Stella is syncing your billing now.",
    );
  }, []);

  const handleCheckoutComplete = useCallback(() => {
    setCheckoutSession(null);
    setPendingPlan(null);
    setCheckoutNotice(
      "Payment received. Your updated plan will appear in a moment.",
    );
  }, []);

  const handleStartCheckout = useCallback(
    async (plan: PaidBillingPlan) => {
      if (!hasConnectedAccount) {
        // Plans are visible to everyone, but subscribing requires a real
        // account. Take the user straight to sign-in instead of an inline
        // error they can't act on.
        openAuthDialog();
        return;
      }

      setBillingError(null);
      setCheckoutNotice(null);
      setIsStartingCheckoutPlan(plan);
      setPendingPlan(plan);

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
        setCheckoutSession({ publishableKey, clientSecret, sessionId });
      } catch (error) {
        setPendingPlan(null);
        setBillingError(
          getErrorMessage(error, "Unable to start checkout right now."),
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
        getErrorMessage(error, "Unable to open billing management right now."),
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

  const isCheckoutOpen = checkoutSession !== null && checkoutOptions !== null;
  const checkoutPlanDisplay = pendingPlan ? getPlanDisplay(pendingPlan) : null;

  const handleCheckoutOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setCheckoutSession(null);
      setPendingPlan(null);
    }
  }, []);

  const formatUsageLine = (plan: BillingPlan) => {
    const display = getPlanDisplay(plan);
    if (plan === "free") {
      return (
        <>
          A taste of Stella with{" "}
          <strong>{usdFormatter.format(display.monthlyUsageUsd)}</strong> of
          included monthly usage.
        </>
      );
    }
    return (
      <>
        Around{" "}
        <strong>{usdFormatter.format(display.monthlyUsageUsd)}</strong> of
        included usage each month.
      </>
    );
  };

  return (
    <div className="bl">
      <div className="bl-shell">
        <header className="bl-hero">
          <p className="bl-eyebrow">Billing</p>
          <h1 className="bl-title">
            Choose how much <em>Stella</em>.
          </h1>
          <p className="bl-lead">
            Every plan includes the full Stella experience. The only thing
            that changes between tiers is how much you can use her each
            month.
          </p>
        </header>

        {billingError ? (
          <p className="bl-notice bl-notice--error" role="alert">
            {billingError}
          </p>
        ) : null}

        {checkoutNotice ? (
          <p className="bl-notice">{checkoutNotice}</p>
        ) : null}

        <div className="bl-status">
          <div className="bl-status-info">
            <span className="bl-status-label">Current plan</span>
            <span className="bl-status-value">
              {isLoadingStatus
                ? "…"
                : getPlanDisplay(currentPlan).label}
            </span>
          </div>

          {usage && planCatalog ? (
            <div className="bl-status-meter">
              <div className="bl-status-meter-label">
                <span>Usage this month</span>
                <span>
                  {usdFormatter.format(usage.monthlyUsedUsd)} /{" "}
                  {usdFormatter.format(usage.monthlyLimitUsd)}
                </span>
              </div>
              <div className="bl-meter-track">
                <div
                  className="bl-meter-fill"
                  style={{
                    width: `${toUsagePercent(usage.monthlyUsedUsd, usage.monthlyLimitUsd)}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          <div className="bl-status-actions">
            <button
              type="button"
              className="bl-link-button"
              onClick={() => void handleOpenBillingPortal()}
              disabled={
                !hasConnectedAccount ||
                isOpeningPortal ||
                isLoadingStatus ||
                !planCatalog ||
                currentPlan === "free"
              }
            >
              {isOpeningPortal ? "Opening…" : "Manage billing →"}
            </button>
          </div>
        </div>

        <section className="bl-plans-section">
          <div className="bl-section-head">
            <h2 className="bl-section-title">Plans</h2>
            <p className="bl-section-sub">
              Cancel or change anytime. Prices in USD.
            </p>
          </div>

          <div className="bl-plans-grid">
            {PLAN_ORDER.map((plan) => {
              const display = getPlanDisplay(plan);
              const isCurrentPlan = plan === currentPlan;
              const isPaidPlan = plan !== "free";
              const isStartingThisPlan = isStartingCheckoutPlan === plan;
              const isRecommended =
                plan === RECOMMENDED_PLAN && currentPlan !== RECOMMENDED_PLAN;

              const ctaLabel = isCurrentPlan
                ? "Current plan"
                : isStartingThisPlan
                  ? "Opening…"
                  : !hasConnectedAccount && isPaidPlan
                    ? `Sign in for ${display.label}`
                    : isPaidPlan
                      ? `Choose ${display.label}`
                      : "Included";

              return (
                <div
                  key={plan}
                  className="bl-plan"
                  data-active={isCurrentPlan || undefined}
                  data-recommended={isRecommended || undefined}
                >
                  <div className="bl-plan-name">{display.label}</div>

                  <div className="bl-plan-price">
                    <span className="bl-plan-price-value">
                      {display.monthlyPriceCents <= 0
                        ? "Free"
                        : priceFormatter.format(
                            display.monthlyPriceCents / 100,
                          )}
                    </span>
                    {display.monthlyPriceCents > 0 ? (
                      <span className="bl-plan-price-period">/mo</span>
                    ) : null}
                  </div>

                  <p className="bl-plan-allotment">{formatUsageLine(plan)}</p>

                  <hr className="bl-plan-rule" />

                  <button
                    type="button"
                    className={
                      "bl-plan-cta" +
                      (isCurrentPlan ? " bl-plan-cta--current" : "")
                    }
                    onClick={() => {
                      if (isPaidPlan && !isCurrentPlan) {
                        void handleStartCheckout(plan as PaidBillingPlan);
                      }
                    }}
                    disabled={
                      isCurrentPlan ||
                      !isPaidPlan ||
                      isStartingCheckoutPlan !== null
                    }
                  >
                    {ctaLabel}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="bl-features">
            <div className="bl-features-head">Included on every plan</div>
            <ul className="bl-features-list">
              {SHARED_FEATURES.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <Dialog open={isCheckoutOpen} onOpenChange={handleCheckoutOpenChange}>
        <Dialog.Content
          size="xl"
          className="bl-checkout-dialog"
          onInteractOutside={(event) => {
            // Stripe's iframe occasionally fires synthetic outside-click
            // events during card form interactions; let the explicit close
            // button drive dismissal so users can't accidentally lose state.
            event.preventDefault();
          }}
        >
          <Dialog.Title className="bl-sr-only">Checkout</Dialog.Title>
          <div className="bl-checkout-head">
            <div className="bl-checkout-head-text">
              <span className="bl-checkout-eyebrow">Subscribe</span>
              <h3 className="bl-checkout-title">
                {checkoutPlanDisplay
                  ? `Stella ${checkoutPlanDisplay.label}`
                  : "Stella"}
              </h3>
            </div>
            <button
              type="button"
              className="bl-checkout-close"
              aria-label="Close checkout"
              onClick={() => handleCheckoutOpenChange(false)}
            >
              ×
            </button>
          </div>
          <div className="bl-checkout-body">
            {checkoutSession && checkoutOptions ? (
              <EmbeddedCheckoutProvider
                stripe={getStripePromise(checkoutSession.publishableKey)}
                options={checkoutOptions}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}
