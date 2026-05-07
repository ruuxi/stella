import { useEffect, useRef } from "react";
import {
  clearRequestSignInAfterOnboarding,
  consumeRequestSignInAfterOnboarding,
} from "@/shared/lib/stella-orb-chat";

type UseOnboardingMemoryPromotionOptions = {
  hasConnectedAccount: boolean;
  isAuthLoading: boolean;
  showAuthDialog: () => void;
};

/**
 * One-shot consumer for "user opted into Live Memory during onboarding".
 *
 * On first render after onboarding, promote immediately if signed in;
 * otherwise open auth and remember the intent so auth completion can
 * promote it. Waits for the auth session to finish loading before
 * deciding — otherwise we'd flash the dialog on every refresh.
 */
export function useOnboardingMemoryPromotion({
  hasConnectedAccount,
  isAuthLoading,
  showAuthDialog,
}: UseOnboardingMemoryPromotionOptions): void {
  const memorySignInPendingRef = useRef(false);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!consumeRequestSignInAfterOnboarding()) return;
    if (hasConnectedAccount) {
      // Already signed in (e.g. user signed in mid-onboarding). Just
      // promote the pending intent — no dialog needed.
      void window.electronAPI?.memory?.promotePending().catch(() => {
        // Best-effort; user can re-toggle from Settings.
      });
      return;
    }
    memorySignInPendingRef.current = true;
    showAuthDialog();
  }, [hasConnectedAccount, isAuthLoading, showAuthDialog]);

  // Once the user successfully signs in (after we opened the dialog for
  // memory), promote Live Memory's pending intent into a real enable.
  useEffect(() => {
    if (!hasConnectedAccount) return;
    if (!memorySignInPendingRef.current) return;
    memorySignInPendingRef.current = false;
    clearRequestSignInAfterOnboarding();
    void window.electronAPI?.memory?.promotePending().catch(() => {
      // Best-effort; user can re-toggle from Settings.
    });
  }, [hasConnectedAccount]);
}
