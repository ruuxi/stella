import { useEffect, useRef } from "react";
import type { useRouter } from "@tanstack/react-router";
import { readPersistedLastLocation } from "@/shared/lib/last-location";
import { useWindowType } from "@/shared/hooks/use-window-type";

type Router = ReturnType<typeof useRouter>;

/**
 * Restore the last persisted location exactly once. Reads synchronously
 * from the shared UI state store (no async hydration race) and only navigates if
 * the pathname matches a registered route in this router. Anything
 * else falls through to the memory-history default (`/chat`).
 *
 * The mini window shares the UI state store with the full window, so it must
 * never restore the full window's last route — it always opens at home.
 */
export function useLastLocationRestore(router: Router): void {
  const isMiniWindow = useWindowType() === "mini";
  const restoredRef = useRef(false);
  useEffect(() => {
    if (isMiniWindow) return;
    if (restoredRef.current) return;
    restoredRef.current = true;

    const target = readPersistedLastLocation();
    if (!target || target === "/chat" || target === "/") return;

    const queryIndex = target.indexOf("?");
    const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
    const knownPaths = router.routesByPath as unknown as Record<
      string,
      unknown
    >;
    // User apps live on the dynamic `/apps/$slug` route, which never
    // appears in `routesByPath`, so restores to them were silently
    // dropped — a self-mod covered reload or app restart while the user
    // was on an app page dumped them back to /chat.
    const isUserAppPath = /^\/apps\/[a-z][a-z0-9-]*$/.test(pathname);
    if (
      !isUserAppPath &&
      !Object.prototype.hasOwnProperty.call(knownPaths, pathname)
    ) {
      return;
    }

    const search = queryIndex === -1 ? "" : target.slice(queryIndex + 1);
    const searchParams = Object.fromEntries(new URLSearchParams(search));

    void router.navigate({
      to: pathname,
      search: searchParams as never,
    });
  }, [router, isMiniWindow]);
}
