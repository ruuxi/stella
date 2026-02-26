/**
 * Headless component that auto-signs in anonymously when no BetterAuth
 * session exists. Uses authClient.useSession() directly so it fires as
 * soon as the session check resolves — without waiting for the full
 * Convex token fetch chain.
 */

import { useEffect, useRef } from "react";
import { authClient } from "@/lib/auth-client";

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

    void authClient.signIn.anonymous().catch((error: unknown) => {
      console.warn("[AutoAnonAuth] Anonymous sign-in failed:", error);
      attemptedRef.current = false;
    });
  }, [session.isPending, session.data]);

  return null;
};
