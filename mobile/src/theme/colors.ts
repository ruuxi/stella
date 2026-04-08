export type Colors = {
  // Core backgrounds
  background: string;
  backgroundWeak: string;
  backgroundStrong: string;
  surface: string;
  panel: string;

  // Borders
  border: string;
  borderWeak: string;
  borderStrong: string;

  // Text
  text: string;
  textMuted: string;
  textStrong: string;

  // Brand / primary
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentForeground: string;

  // Decorative accent (distinct from brand — e.g. pink in Carbon, orange in Neon)
  decorative: string;
  decorativeForeground: string;

  // Status
  ok: string;
  warning: string;
  danger: string;
  info: string;

  // Surfaces
  card: string;
  cardForeground: string;
  muted: string;
  mutedForeground: string;

  // Overlay
  overlay: string;
};

/** Fallback light palette — used when no theme is loaded yet. */
export const lightColors: Colors = {
  background: "#f2f4f8",
  backgroundWeak: "#e8ebf0",
  backgroundStrong: "#f8f9fb",
  surface: "#f8f9fb",
  panel: "#dde1e6",

  border: "#c1c7cd",
  borderWeak: "#dde1e6",
  borderStrong: "#878d96",

  text: "#161616",
  textMuted: "#4d5358",
  textStrong: "#000000",

  accent: "#0f62fe",
  accentHover: "#0f62fe",
  accentSoft: "#edf1fc",
  accentForeground: "#ffffff",

  decorative: "#ee5396",
  decorativeForeground: "#ffffff",

  ok: "#42be65",
  warning: "#f1c21b",
  danger: "#da1e28",
  info: "#4589ff",

  card: "rgba(255, 255, 255, 0.9)",
  cardForeground: "#161616",
  muted: "#dde1e6",
  mutedForeground: "#4d5358",

  overlay: "#5a5a5a",
};

/** Fallback dark palette — used when no theme is loaded yet. */
export const darkColors: Colors = {
  background: "#161616",
  backgroundWeak: "#1c1c1c",
  backgroundStrong: "#0f0f0f",
  surface: "#1c1c1c",
  panel: "#262626",

  border: "#393939",
  borderWeak: "#262626",
  borderStrong: "#525252",

  text: "#f2f4f8",
  textMuted: "#b8bfc7",
  textStrong: "#ffffff",

  accent: "#78a9ff",
  accentHover: "#78a9ff",
  accentSoft: "#1d2636",
  accentForeground: "#161616",

  decorative: "#ff7eb6",
  decorativeForeground: "#161616",

  ok: "#42be65",
  warning: "#f1c21b",
  danger: "#ff8389",
  info: "#4589ff",

  card: "rgba(38, 38, 38, 0.9)",
  cardForeground: "#f2f4f8",
  muted: "#262626",
  mutedForeground: "#b8bfc7",

  overlay: "#1a1a1a",
};

/** @deprecated Use `useColors()` from theme-context instead. */
export const colors = lightColors;
