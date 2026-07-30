import { useEffect } from "react";
import type { useRouter } from "@tanstack/react-router";
import { writePersistedLastLocation } from "@/shared/lib/last-location";

type Router = ReturnType<typeof useRouter>;

/**
 * Persist every router resolution to the shared UI state store so a
 * fresh launch can restore which *route* the user was on (store / social /
 * settings / …). We deliberately don't round-trip this through IPC.
 *
 * This intentionally does NOT carry the chat conversation id: the durable
 * active-conversation pointer (SQLite, written from `__root`) is the single
 * source of truth for that, and the `/chat` route loader backfills `?c=`
 * from it. Persisting `?c=` here too would create a second, drift-prone
 * source — and stripped-`c` navigations (`navigate({ to: "/chat" })`) would
 * silently poison it. So we store a bare `/chat` for any chat location.
 *
 */
export function usePersistLastLocation(router: Router): void {
  useEffect(() => {
    return router.subscribe("onResolved", ({ toLocation }) => {
      const href =
        toLocation.pathname === "/chat" ? "/chat" : toLocation.href;
      writePersistedLastLocation(href);
    });
  }, [router]);
}
