import { useEffect } from "react";
import type { useRouter } from "@tanstack/react-router";
import { writePersistedLastLocation } from "@/shared/lib/last-location";

type Router = ReturnType<typeof useRouter>;

/**
 * Persist every router resolution to renderer-side `localStorage` so a
 * fresh launch can restore where the user was. We deliberately don't
 * round-trip this through IPC — no other window cares.
 */
export function usePersistLastLocation(router: Router): void {
  useEffect(() => {
    return router.subscribe("onResolved", ({ toLocation }) => {
      writePersistedLastLocation(toLocation.href);
    });
  }, [router]);
}
