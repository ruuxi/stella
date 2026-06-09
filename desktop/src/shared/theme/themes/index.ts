import pearl from "./pearl";
import noir from "./noir";
import custom from "./custom";
import type { Theme, ThemeColors } from "./types";

export type { Theme, ThemeColors };

// Curated to two impeccable, fully-tuned themes — Light (pearl) and Dark
// (noir) — plus the invisible Custom overlay every user starts on. The wider
// theme zoo (dracula, catppuccin, gruvbox, …) is intentionally unregistered:
// the engine still supports it (the files remain on disk), but shipping ~18
// uneven themes reads as immature. Re-add an import here to bring one back.
const themes: Theme[] = [
  custom,
  pearl, noir,
];

const listeners = new Set<() => void>();
let themesSnapshot: readonly Theme[] = themes.slice();

const refreshThemesSnapshot = () => {
  themesSnapshot = themes.slice();
};

const emitChange = () => {
  refreshThemesSnapshot();
  for (const listener of listeners) {
    listener();
  }
};

export const getThemeById = (id: string): Theme | undefined => {
  return themes.find((t) => t.id === id);
};

// Everyone starts on the Custom overlay; while empty it renders as its base
// (Pearl), so the default look is unchanged.
export const defaultTheme = themes.find((t) => t.id === "custom")!;

/**
 * Effective colors for a theme. Overlay themes (those with `base`) inherit the
 * base theme's colors for the given appearance and merge their per-mode
 * `overrides` on top. Non-overlay themes return their own colors directly.
 * Also reports the base id (for `data-base-theme`) and effective forced mode.
 */
export const resolveThemeColors = (
  theme: Theme,
  isDark: boolean,
  baseOverrideId?: string,
): { colors: ThemeColors; baseThemeId?: string; forcedMode?: "light" | "dark" } => {
  if (!theme.base && !baseOverrideId) {
    const dark = theme.forcedMode ? theme.forcedMode === "dark" : isDark;
    return {
      colors: dark ? theme.dark : theme.light,
      forcedMode: theme.forcedMode,
    };
  }
  // Overlay: inherit from the runtime base override (the base the user has
  // Custom displaying) when present, else the theme's declared base.
  const baseId = baseOverrideId ?? theme.base;
  const baseTheme = baseId ? getThemeById(baseId) : undefined;
  const forcedMode = theme.forcedMode ?? baseTheme?.forcedMode;
  const resolvedDark = forcedMode ? forcedMode === "dark" : isDark;
  const baseColors = baseTheme
    ? resolvedDark
      ? baseTheme.dark
      : baseTheme.light
    : resolvedDark
      ? theme.dark
      : theme.light;
  const modeOverrides = resolvedDark ? theme.overrides?.dark : theme.overrides?.light;
  return {
    colors: modeOverrides ? { ...baseColors, ...modeOverrides } : baseColors,
    baseThemeId: baseTheme?.id ?? baseId,
    forcedMode,
  };
};

/** Whether a theme should be hidden from the picker (empty overlay). */
export const isHiddenOverlay = (theme: Theme): boolean =>
  theme.base !== undefined && !theme.populated;

export const subscribeThemes = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getThemesSnapshot = (): readonly Theme[] => themesSnapshot;

export const registerTheme = (theme: Theme) => {
  const existing = themes.findIndex((t) => t.id === theme.id);
  if (existing >= 0) {
    themes[existing] = theme;
  } else {
    themes.push(theme);
  }
  emitChange();
};
