import { useMemo } from "react";

/** Returns 'mini' or 'full' based on the URL search param. Stable across renders. */
export function useWindowType(): "mini" | "full" {
  return useMemo(
    () => new URLSearchParams(window.location.search).get("window") === "mini" ? "mini" : "full",
    [],
  );
}
