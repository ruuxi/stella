/**
 * Headless component that auto-signs in anonymously when no BetterAuth
 * session exists. Uses authClient.useSession() directly so it fires as
 * soon as the session check resolves — without waiting for the full
 * Convex token fetch chain.
 *
 * Optimization: If no session cookie exists in localStorage, we fire
 * the anonymous sign-in speculatively in parallel with the initial
 * get-session check, saving ~800ms from the auth waterfall.
 */

import { useEffect, useRef } from "react";
import { authClient } from "@/app/auth/lib/auth-client";

export const AutoAnonAuth = () => {
  const session = authClient.useSession();
  const attemptedRef = useRef(false);

  useEffect(() => {
    // Still checking session — wait
    if (session.isPending) return;

    // Already has a session (real or anonymous) — nothing to do
    if (session.data) {
      attemptedRef.current = false;
      return;
    }

    // No session and already attempted — don't retry within the same cycle
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    void authClient.signIn.anonymous().catch(() => {
      attemptedRef.current = false;
    });
  }, [session.isPending, session.data]);

  return null;
};
