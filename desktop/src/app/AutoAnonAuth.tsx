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
import { authClient } from "@/lib/auth-client";

// Check synchronously if a session cookie exists — if not, we can
// speculatively fire anonymous sign-in without waiting for get-session.
const hasExistingSession = () => {
  try {
    const cookie = localStorage.getItem("better-auth_cookie");
    return Boolean(cookie && cookie.length > 0);
  } catch {
    return false;
  }
};

// Fire speculative sign-in immediately at module load time (not in a
// useEffect) so it runs in parallel with the initial get-session call.
let speculativeSignInPromise: Promise<unknown> | null = null;
if (!hasExistingSession()) {
  speculativeSignInPromise = authClient.signIn.anonymous().catch((error: unknown) => {
    console.warn("[AutoAnonAuth] Speculative anonymous sign-in failed:", error);
  });
}

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

    // Speculative sign-in already in-flight — don't double-fire
    if (speculativeSignInPromise) {
      speculativeSignInPromise = null;
      attemptedRef.current = true;
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
