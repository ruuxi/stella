import { useMemo } from "react";

const resolveWindowType = (): "mini" | "full" => {
  const dataHint = document.documentElement.dataset.stellaWindow;
  if (dataHint === "mini") {
    return "mini";
  }

  const path = window.location.pathname.toLowerCase();
  if (path.endsWith("/mini.html") || path === "/mini.html") {
    return "mini";
  }

  return new URLSearchParams(window.location.search).get("window") === "mini"
    ? "mini"
    : "full";
};

/** Returns 'mini' or 'full' for voice overlay activity gating. Stable across renders. */
export function useWindowType(): "mini" | "full" {
  return useMemo(() => resolveWindowType(), []);
}
