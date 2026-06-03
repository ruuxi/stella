import { useEffect } from "react";
import type { useRouter } from "@tanstack/react-router";
import { writePersistedLastLocation } from "@/shared/lib/last-location";
import { useWindowType } from "@/shared/hooks/use-window-type";

type Router = ReturnType<typeof useRouter>;

/**
 * Persist every router resolution to renderer-side `localStorage` so a
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
 * Only the full window persists: the mini window shares `localStorage`
 * and always opens at home, so letting it write here would clobber the
 * full window's saved route.
 */
export function usePersistLastLocation(router: Router): void {
  const isMiniWindow = useWindowType() === "mini";
  useEffect(() => {
    if (isMiniWindow) return;
    return router.subscribe("onResolved", ({ toLocation }) => {
      const href =
        toLocation.pathname === "/chat" ? "/chat" : toLocation.href;
      writePersistedLastLocation(href);
    });
  }, [router, isMiniWindow]);
}
