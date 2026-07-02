import { useMemo } from "react";
import { useTheme } from "@/context/theme-context";
import type { EmbeddedWebsiteTheme } from "@/shared/types/electron";

/**
 * Snapshot the small set of theme tokens the embedded website (Store,
 * Billing, …) needs to render any desktop theme legibly. We read directly
 * from the live `:root` CSS custom properties rather than re-deriving from
 * the `Theme` palette, so previewed gradients/colors and any installed
 * custom theme are picked up without extra plumbing.
 */
export const readEmbeddedWebsiteTheme = (
  mode: "light" | "dark",
): EmbeddedWebsiteTheme => {
  if (typeof document === "undefined") return { mode };
  const styles = window.getComputedStyle(document.documentElement);
  const get = (key: string): string | undefined => {
    const value = styles.getPropertyValue(key).trim();
    return value.length > 0 ? value : undefined;
  };
  return {
    mode,
    foreground: get("--foreground"),
    foregroundWeak: get("--muted-foreground"),
    border: get("--border"),
    primary: get("--primary"),
    surface: get("--card") ?? get("--background-strong"),
    background: get("--background"),
  };
};

/**
 * Live snapshot of the desktop theme tokens for the embedded website.
 * `EmbeddedWebsiteView` seeds the initial URL params from this (avoiding a
 * flash of the website's default light gradient) and pushes subsequent
 * changes into the `<webview>` over the theme IPC channel.
 */
export const useEmbeddedWebsiteTheme = (): EmbeddedWebsiteTheme => {
  const { resolvedColorMode, colors } = useTheme();
  return useMemo(
    () => readEmbeddedWebsiteTheme(resolvedColorMode),
    // `colors` is part of the dep set so the snapshot recomputes on any
    // theme change, even though we don't read its fields directly — the
    // CSS variables on `:root` are the source of truth and they update
    // synchronously whenever `colors` does.
    [resolvedColorMode, colors],
  );
};
