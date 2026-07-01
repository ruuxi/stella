import type { Theme, ThemeColors } from "./types";

// "Default" — the single macOS-native default theme with a light and a dark
// variant. Unlike the old separate "Light"/"Dark" themes (which pinned their
// appearance via `forcedMode` and so ignored the mode toggle), Default has no
// forced appearance: its light↔dark rendering is driven entirely by the
// Appearance mode toggle (Light / Dark / System). `flat: true` keeps the old
// single, flat, opaque macOS surface (no ShiftingGradient blob) in both modes.
//
// Both palettes below are the exact colors the retired "Light" and "Dark"
// themes shipped, so the default look is unchanged — only the wiring is fixed
// so "Default + Dark mode" actually goes dark.

// Light variant: white content (#ffffff) with subtle-gray sidebar chrome,
// solid measured text colors, and one restrained accent (system blue).
const light: ThemeColors = {
  background: "#ffffff",
  backgroundWeak: "#f5f5f7",
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

// Dark variant: near-black system chrome (#1c1c1e) with elevated content
// (#2c2c2e), solid measured text colors, and the same restrained system-blue
// accent as the light variant.
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
  id: "default",
  name: "Default",
  // No forcedMode: the Appearance mode toggle drives light↔dark. `flat` keeps
  // the solid, gradient-suppressed surface the old Light/Dark defaults had.
  flat: true,
  light,
  dark,
};

export default theme;
