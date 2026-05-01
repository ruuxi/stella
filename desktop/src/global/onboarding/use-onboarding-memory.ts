import { useCallback } from "react";
import { markRequestSignInAfterOnboarding } from "@/shared/lib/stella-orb-chat";

type MemoryContinueOptions = {
  memoryEnabled: boolean;
  requestSignIn: boolean;
};

export function useOnboardingMemory(nextSplitStep: () => void) {
  return useCallback(
    ({ memoryEnabled }: MemoryContinueOptions) => {
      // Persist the user's choice via the unified memory IPC. The handler
      // keeps Chronicle + Dream in lockstep and stages pending enables when
      // sign-in is needed, so nothing starts until there is an auth session.
      const api = window.electronAPI?.memory;
      if (memoryEnabled) {
        markRequestSignInAfterOnboarding();
        void api?.setEnabled(true, { pending: true }).catch(() => {
          // Best-effort: a failure here just means the daemon stays off.
          // The user can re-toggle from Settings.
        });
      } else {
        void api?.setEnabled(false).catch(() => {
          // Best-effort.
        });
      }
      nextSplitStep();
    },
    [nextSplitStep],
  );
}
