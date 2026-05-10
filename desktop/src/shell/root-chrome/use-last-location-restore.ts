import { useEffect, useRef } from "react";
import type { useRouter } from "@tanstack/react-router";
import { readPersistedLastLocation } from "@/shared/lib/last-location";

type Router = ReturnType<typeof useRouter>;

/**
 * Restore the last persisted location exactly once. Reads synchronously
 * from `localStorage` (no async hydration race) and only navigates if
 * the pathname matches a registered route in this router. Anything
 * else falls through to the memory-history default (`/chat`).
 */
export function useLastLocationRestore(router: Router): void {
  const restoredRef = useRef(false);
  useEffect(() => {
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
    if (!Object.prototype.hasOwnProperty.call(knownPaths, pathname)) return;

    const search = queryIndex === -1 ? "" : target.slice(queryIndex + 1);
    const searchParams = Object.fromEntries(new URLSearchParams(search));

    void router.navigate({
      to: pathname,
      search: searchParams as never,
    });
  }, [router]);
}
