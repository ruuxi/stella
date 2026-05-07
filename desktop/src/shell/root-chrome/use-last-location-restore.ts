import { useEffect, useRef } from "react";
import type { useRouter } from "@tanstack/react-router";
import { hasBillingCheckoutCompletionMarker } from "@/global/settings/lib/billing-checkout";
import { readPersistedLastLocation } from "@/shared/lib/last-location";

type Router = ReturnType<typeof useRouter>;

/**
 * Restore the last persisted location exactly once. Reads synchronously
 * from `localStorage` (no async hydration race) and only navigates if
 * the pathname matches a registered route in this router. Anything
 * else falls through to the memory-history default (`/chat`).
 *
 * Stripe checkout return URLs carry the `?billingCheckout=complete`
 * marker on `window.location`; when present we skip the persisted
 * restore and go straight to `/billing` so the BillingScreen can
 * consume the marker and show the post-checkout state.
 */
export function useLastLocationRestore(router: Router): void {
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    if (hasBillingCheckoutCompletionMarker()) {
      void router.navigate({ to: "/billing" });
      return;
    }

    const target = readPersistedLastLocation();
    if (!target || target === "/chat" || target === "/") return;

    const queryIndex = target.indexOf("?");
    const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
    const knownPaths = router.routesByPath as unknown as Record<
      string,
      unknown
    >;
    if (!Object.prototype.hasOwnProperty.call(knownPaths, pathname)) return;

    const search = queryIndex === -1 ? "" : target.slice(queryIndex + 1);
    const searchParams = Object.fromEntries(new URLSearchParams(search));

    void router.navigate({
      to: pathname,
      search: searchParams as never,
    });
  }, [router]);
}
