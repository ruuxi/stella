import oc1 from "./oc1";
import tokyonight from "./tokyonight";
import dracula from "./dracula";
import catppuccin from "./catppuccin";
import nord from "./nord";
import monokai from "./monokai";
import solarized from "./solarized";
import onedarkpro from "./onedarkpro";
import shadesofpurple from "./shadesofpurple";
import nightowl from "./nightowl";
import vesper from "./vesper";
import carbonfox from "./carbonfox";
import gruvbox from "./gruvbox";
import ayu from "./ayu";
import aura from "./aura";
import type { Theme, ThemeColors } from "./types";

export type { Theme, ThemeColors };

export const themes: Theme[] = [
  oc1, tokyonight, dracula, catppuccin, nord, monokai, solarized,
  onedarkpro, shadesofpurple, nightowl, vesper, carbonfox, gruvbox, ayu, aura,
];

export const getThemeById = (id: string): Theme | undefined => {
  return themes.find((t) => t.id === id);
};

export const defaultTheme = themes.find((t) => t.id === "carbonfox")!;

export const registerTheme = (theme: Theme) => {
  const existing = themes.findIndex((t) => t.id === theme.id);
  if (existing >= 0) {
    themes[existing] = theme;
  } else {
    themes.push(theme);
  }
};

export const unregisterTheme = (id: string) => {
  const index = themes.findIndex((t) => t.id === id);
  if (index >= 0) {
    themes.splice(index, 1);
  }
};
