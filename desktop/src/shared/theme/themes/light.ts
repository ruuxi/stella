import type { Theme, ThemeColors } from "./types";

// "Light" — the macOS-native light theme and the product default. Pinned to
// light appearance with a single flat, opaque surface (forcedMode → flat
// gradient = solid fill): system-gray window chrome (#ececec) with white
// content (#ffffff), solid measured text colors, and one restrained accent
// (system blue). Replaces the old "Pearl".
const light: ThemeColors = {
  background: "#ececec",
  backgroundWeak: "#e3e3e8",
  backgroundStrong: "#ffffff",
  foreground: "#1d1d1f",
  foregroundWeak: "#86868b",
  foregroundStrong: "#000000",
  primary: "#0a84ff",
  primaryForeground: "#ffffff",
  success: "#34c759",
  warning: "#ff9f0a",
  error: "#ff3b30",
  info: "#0a84ff",
  interactive: "#0a84ff",
  border: "#d6d6d6",
  borderWeak: "#e5e5e5",
  borderStrong: "#c4c4c4",
  card: "#ffffff",
  cardForeground: "#1d1d1f",
  muted: "#e9e9ee",
  mutedForeground: "#86868b",
  accent: "#e8e8ed",
  accentForeground: "#1d1d1f",
  // Neutral anchor (background) — the flat substrate carries no visible blob.
  gradientAnchor: "#ececec",
};

const theme: Theme = {
  id: "light",
  name: "Light",
  forcedMode: "light",
  light,
  dark: light,
};

export default theme;
