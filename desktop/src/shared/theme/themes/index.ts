import oc1 from "./oc1";
import dracula from "./dracula";
import catppuccin from "./catppuccin";
import monokai from "./monokai";
import solarized from "./solarized";
import shadesofpurple from "./shadesofpurple";
import nightowl from "./nightowl";
import vesper from "./vesper";
import gruvbox from "./gruvbox";
import ayu from "./ayu";
import aura from "./aura";
import pearl from "./pearl";
import noir from "./noir";
import sage from "./sage";
import crimson from "./crimson";
import slate from "./slate";
import cocoa from "./cocoa";
import custom from "./custom";
import type { Theme, ThemeColors } from "./types";

export type { Theme, ThemeColors };

const themes: Theme[] = [
  custom,
  pearl, noir,
  oc1, dracula, catppuccin, monokai, solarized,
  shadesofpurple, nightowl, vesper, gruvbox, ayu, aura,
  sage, crimson, slate, cocoa,
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
): { colors: ThemeColors; baseThemeId?: string; forcedMode?: "light" | "dark" } => {
  if (!theme.base) {
    const dark = theme.forcedMode ? theme.forcedMode === "dark" : isDark;
    return {
      colors: dark ? theme.dark : theme.light,
      forcedMode: theme.forcedMode,
    };
  }
  const baseTheme = getThemeById(theme.base);
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
    baseThemeId: baseTheme?.id ?? theme.base,
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
