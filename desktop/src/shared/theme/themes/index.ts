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
import type { Theme, ThemeColors } from "./types";

export type { Theme, ThemeColors };

const themes: Theme[] = [
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

export const defaultTheme = themes.find((t) => t.id === "nightowl")!;

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
