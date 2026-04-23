/** Returns 'mini', 'full', or 'overlay' for voice overlay activity gating. */
export function useWindowType(): "mini" | "full" | "overlay" {
  const dataHint = document.documentElement.dataset.stellaWindow;
  if (dataHint === "mini") {
    return "mini";
  }
  if (dataHint === "overlay") {
    return "overlay";
  }

  const path = window.location.pathname.toLowerCase();
  if (path.endsWith("/overlay.html") || path === "/overlay.html") {
    return "overlay";
  }

  const windowParam = new URLSearchParams(window.location.search).get("window");
  if (windowParam === "mini") {
    return "mini";
  }

  return "full";
}
