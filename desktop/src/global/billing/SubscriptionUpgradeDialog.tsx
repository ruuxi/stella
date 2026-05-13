import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import "./SubscriptionUpgradeDialog.css";

type BillingPlanId = "free" | "go" | "pro" | "plus" | "ultra";

type BillingStatusLite = {
  plan?: BillingPlanId;
  plans?: Partial<Record<BillingPlanId, { label?: string }>>;
};

const PAID_PLANS: ReadonlySet<BillingPlanId> = new Set([
  "go",
  "pro",
  "plus",
  "ultra",
]);

const DEFAULT_PLAN_LABEL: Record<BillingPlanId, string> = {
  free: "Free",
  go: "Go",
  pro: "Pro",
  plus: "Plus",
  ultra: "Ultra",
};

const planLabelOf = (
  plan: BillingPlanId,
  status: BillingStatusLite | undefined,
): string => status?.plans?.[plan]?.label ?? DEFAULT_PLAN_LABEL[plan];

const storageKeyFor = (accountKey: string) =>
  `stella-billing-last-seen-plan:${accountKey}`;

/** Fired after the dialog persists a new paid plan so other surfaces (the
 *  sidebar account pill, for example) can refetch their cached billing
 *  status without holding a live `useQuery` watcher of their own. */
export const SUBSCRIPTION_UPGRADED_EVENT = "stella:subscription-upgraded";

/**
 * Mounted once near the app root. Watches the Convex `billing` query (which
 * is already updated reactively by Stripe webhooks on the backend) and
 * surfaces a celebratory dialog the first time the user's plan transitions
 * from one value to a different paid value.
 *
 * The "first read after sign-in" is treated as a silent seed so existing
 * paid users don't see the dialog every cold start. Downgrades and
 * cancellations are also silent — we just update the stored baseline so a
 * future upgrade re-celebrates.
 *
 * Convex is reactive end-to-end here: Stripe's `checkout.session.completed`
 * (and `customer.subscription.*`) webhook lands in
 * `backend/convex/http_routes/stripe.ts`, which writes the new plan to the
 * user's billing row; this `useQuery` pushes the change to the desktop
 * over the existing Convex WebSocket within ~1s. No extra IPC or deep-link
 * channel is needed.
 */
export function SubscriptionUpgradeDialog() {
  const { hasConnectedAccount } = useAuthSessionState();
  const { user } = useCurrentUser();
  // Scope the "last seen plan" to the signed-in account so switching
  // accounts on the same machine doesn't cross-fire (or silently mask) a
  // celebration that belongs to the other identity.
  const accountKey = user?.email?.toLowerCase() ?? "";

  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
  ) as BillingStatusLite | undefined;

  const [shownPlan, setShownPlan] = useState<BillingPlanId | null>(null);
  // Guard against the React 18 StrictMode double-effect in dev firing the
  // seed/celebrate logic twice for the same account+plan tuple. We only
  // need to act once per change.
  const lastProcessedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hasConnectedAccount) {
      lastProcessedRef.current = null;
      return;
    }
    if (!accountKey) return;
    const plan = billingStatus?.plan;
    if (!plan) return;

    const fingerprint = `${accountKey}|${plan}`;
    if (lastProcessedRef.current === fingerprint) return;
    lastProcessedRef.current = fingerprint;

    const storageKey = storageKeyFor(accountKey);
    let stored: BillingPlanId | null = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw && raw in DEFAULT_PLAN_LABEL) {
        stored = raw as BillingPlanId;
      }
    } catch {
      // localStorage can be unavailable (private windows, embedded
      // contexts) — fall through and treat as "no baseline".
    }

    if (stored === plan) return;

    try {
      window.localStorage.setItem(storageKey, plan);
    } catch {
      // Same as above — if we can't persist, we'd re-fire next mount, but
      // that's strictly better than swallowing the celebration entirely.
    }

    // First read after sign-in (no baseline) is a silent seed so we don't
    // celebrate plans the user has been on for months.
    if (stored === null) return;

    // Downgrades / cancellations: update the baseline so a re-upgrade
    // re-celebrates, but stay silent.
    if (!PAID_PLANS.has(plan)) return;

    setShownPlan(plan);
    window.dispatchEvent(new CustomEvent(SUBSCRIPTION_UPGRADED_EVENT));
  }, [accountKey, billingStatus, hasConnectedAccount]);

  const onClose = useCallback(() => setShownPlan(null), []);

  const message = useMemo(() => {
    if (!shownPlan) return null;
    const label = planLabelOf(shownPlan, billingStatus);
    return {
      title: `You're on Stella ${label}.`,
      description:
        "Thanks for the upgrade. Higher priority and increased usage are active now — keep going.",
    };
  }, [billingStatus, shownPlan]);

  if (!message) return null;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="subscription-upgrade-dialog">
        <DialogHeader>
          <DialogTitle>{message.title}</DialogTitle>
          <DialogDescription>{message.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="subscription-upgrade-dialog-body">
          <div className="subscription-upgrade-actions">
            <Button
              type="button"
              variant="primary"
              className="pill-btn pill-btn--primary"
              onClick={onClose}
            >
              Get started
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
