import { useMemo } from "react";

const resolveWindowType = (): "mini" | "full" | "overlay" => {
  const dataHint = document.documentElement.dataset.stellaWindow;
  if (dataHint === "mini") {
    return "mini";
  }
  if (dataHint === "overlay") {
    return "overlay";
  }

  const path = window.location.pathname.toLowerCase();
  if (path.endsWith("/mini.html") || path === "/mini.html") {
    return "mini";
  }
  if (path.endsWith("/overlay.html") || path === "/overlay.html") {
    return "overlay";
  }

  return new URLSearchParams(window.location.search).get("window") === "mini"
    ? "mini"
    : "full";
};

/** Returns 'mini', 'full', or 'overlay' for voice overlay activity gating. Stable across renders. */
export function useWindowType(): "mini" | "full" | "overlay" {
  return useMemo(() => resolveWindowType(), []);
}
