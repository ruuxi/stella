import type { Theme, ThemeColors } from "./types";

// Noir is a standardized "black" theme. It is pinned to dark appearance
// and ignores the gradient controls — same single palette regardless of
// system Light/Dark or gradient settings. Background uses a warm charcoal
// black rather than pure #000000, avoiding OLED smear while keeping Noir dark.
const noir: ThemeColors = {
  background: "#161513",
  backgroundWeak: "#11100f",
  backgroundStrong: "#211f1c",
  foreground: "#f0eee8",
  foregroundWeak: "#a09a90",
  foregroundStrong: "#fbfbf7",
  primary: "#f0eee8",
  primaryForeground: "#161513",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",
  info: "#60a5fa",
  interactive: "#f0eee8",
  border: "#343029",
  borderWeak: "#26231f",
  borderStrong: "#4a443a",
  card: "rgba(33, 31, 28, 0.94)",
  cardForeground: "#f0eee8",
  muted: "#24211d",
  mutedForeground: "#a09a90",
  accent: "#2d2924",
  accentForeground: "#f0eee8",
  // Match the background so the flat blob disappears into the surface.
  gradientAnchor: "#161513",
};

const theme: Theme = {
  id: "noir",
  name: "Noir",
  forcedMode: "dark",
  light: noir,
  dark: noir,
};

export default theme;
