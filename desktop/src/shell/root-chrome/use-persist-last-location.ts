import { useEffect } from "react";
import type { useRouter } from "@tanstack/react-router";
import { writePersistedLastLocation } from "@/shared/lib/last-location";
import { useWindowType } from "@/shared/hooks/use-window-type";

type Router = ReturnType<typeof useRouter>;

/**
 * Persist every router resolution to renderer-side `localStorage` so a
 * fresh launch can restore where the user was. We deliberately don't
 * round-trip this through IPC.
 *
 * Only the full window persists: the mini window shares `localStorage`
 * and always opens at home, so letting it write here would clobber the
 * full window's saved route.
 */
export function usePersistLastLocation(router: Router): void {
  const isMiniWindow = useWindowType() === "mini";
  useEffect(() => {
    if (isMiniWindow) return;
    return router.subscribe("onResolved", ({ toLocation }) => {
      writePersistedLastLocation(toLocation.href);
    });
  }, [router, isMiniWindow]);
}
