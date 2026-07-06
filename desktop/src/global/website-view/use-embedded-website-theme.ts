import { useMemo } from "react";
import { useTheme } from "@/context/theme-context";
import type { ThemeColors } from "@/shared/theme/themes";
import type { EmbeddedWebsiteTheme } from "@/shared/types/electron";

/**
 * Snapshot the small set of theme tokens the embedded website (Store,
 * Billing, …) needs to render any desktop theme legibly. We derive these
 * straight from the resolved `colors` palette — the same source
 * `ThemeProvider` uses to write the `:root` CSS custom properties — rather
 * than reading `getComputedStyle` during render. The CSS variables are
 * written by ThemeProvider's apply effect, which runs AFTER this consumer
 * renders, so reading them here would capture the previous theme and leave
 * the webview one theme change behind. The field↔var mapping mirrors
 * `applyThemeToDocument`: --foreground, --muted-foreground, --border,
 * --primary, --card (the surface), and --background. Previewed themes flow
 * through `colors` too, so they are picked up without extra plumbing.
 */
export const readEmbeddedWebsiteTheme = (
  mode: "light" | "dark",
  colors: ThemeColors,
): EmbeddedWebsiteTheme => ({
  mode,
  foreground: colors.foreground,
  foregroundWeak: colors.mutedForeground,
  border: colors.border,
  primary: colors.primary,
  surface: colors.card,
  background: colors.background,
});

/**
 * Live snapshot of the desktop theme tokens for the embedded website.
 * `EmbeddedWebsiteView` seeds the initial URL params from this (avoiding a
 * flash of the website's default light gradient) and pushes subsequent
 * changes into the `<webview>` over the theme IPC channel.
 */
export const useEmbeddedWebsiteTheme = (): EmbeddedWebsiteTheme => {
  const { resolvedColorMode, colors } = useTheme();
  return useMemo(
    () => readEmbeddedWebsiteTheme(resolvedColorMode, colors),
    [resolvedColorMode, colors],
  );
};
