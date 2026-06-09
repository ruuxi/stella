import type { Theme, ThemeColors } from "./types";

// "Dark" — the macOS-native dark theme. Pinned to dark appearance with a
// single flat, opaque surface (forcedMode → flat gradient = solid fill):
// near-black system chrome (#1c1c1e) with elevated content (#2c2c2e), solid
// measured text colors, and the same restrained system-blue accent as Light.
// Replaces the old "Noir".
const dark: ThemeColors = {
  background: "#1c1c1e",
  backgroundWeak: "#161618",
  backgroundStrong: "#2c2c2e",
  foreground: "#f5f5f7",
  foregroundWeak: "#98989d",
  foregroundStrong: "#ffffff",
  primary: "#0a84ff",
  primaryForeground: "#ffffff",
  success: "#30d158",
  warning: "#ff9f0a",
  error: "#ff453a",
  info: "#0a84ff",
  interactive: "#0a84ff",
  border: "#38383a",
  borderWeak: "#2c2c2e",
  borderStrong: "#48484a",
  card: "#2c2c2e",
  cardForeground: "#f5f5f7",
  muted: "#3a3a3c",
  mutedForeground: "#98989d",
  accent: "#3a3a3c",
  accentForeground: "#f5f5f7",
  // Neutral anchor (background) — the flat substrate carries no visible blob.
  gradientAnchor: "#1c1c1e",
};

const theme: Theme = {
  id: "dark",
  name: "Dark",
  forcedMode: "dark",
  light: dark,
  dark,
};

export default theme;
