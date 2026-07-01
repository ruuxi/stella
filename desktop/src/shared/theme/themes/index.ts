import custom from "./custom";
import defaultTheme_ from "./default";
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
import sage from "./sage";
import crimson from "./crimson";
import slate from "./slate";
import cocoa from "./cocoa";
import type { Theme, ThemeColors } from "./types";

export type { Theme, ThemeColors };

// One flat, macOS-native "Default" theme with light+dark variants driven by
// the Appearance mode toggle (Light / Dark / System) — plus the invisible
// Custom overlay every user starts on, and the colorful character themes, which
// render the ShiftingGradient backdrop behind clean opaque panels. (The old
// separate "Light"/"Dark" themes were collapsed into Default: they duplicated
// the mode toggle and, being `forcedMode`-pinned, made "Light theme + Dark
// mode" a no-op.)
const themes: Theme[] = [
  custom,
  defaultTheme_,
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
// (Default), so the default look is unchanged.
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
): {
  colors: ThemeColors;
  baseThemeId?: string;
  forcedMode?: "light" | "dark";
  /** Whether the theme renders flat (gradient-suppressed). `forcedMode` implies flat. */
  flat: boolean;
} => {
  if (!theme.base && !baseOverrideId) {
    const dark = theme.forcedMode ? theme.forcedMode === "dark" : isDark;
    return {
      colors: dark ? theme.dark : theme.light,
      forcedMode: theme.forcedMode,
      flat: theme.forcedMode !== undefined || theme.flat === true,
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
  const flatFlag = theme.flat ?? baseTheme?.flat ?? false;
  return {
    colors: modeOverrides ? { ...baseColors, ...modeOverrides } : baseColors,
    baseThemeId: baseTheme?.id ?? baseId,
    forcedMode,
    flat: forcedMode !== undefined || flatFlag,
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
