import type { Theme, ThemeColors } from "./types";

// Noir is a standardized "black" theme. It is pinned to dark appearance
// and ignores the gradient controls — same single palette regardless of
// system Light/Dark or gradient settings. Near-black neutral surface that
// stays just shy of pure #000000 to avoid OLED smear while reading as black.
const noir: ThemeColors = {
  background: "#0a0a0a",
  backgroundWeak: "#050505",
  backgroundStrong: "#141414",
  foreground: "#f0eee8",
  foregroundWeak: "#9a958c",
  foregroundStrong: "#fbfbf7",
  primary: "#f0eee8",
  primaryForeground: "#0a0a0a",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",
  info: "#60a5fa",
  interactive: "#f0eee8",
  border: "#1f1f1f",
  borderWeak: "#141414",
  borderStrong: "#2a2a2a",
  card: "rgba(20, 20, 20, 0.94)",
  cardForeground: "#f0eee8",
  muted: "#141414",
  mutedForeground: "#9a958c",
  accent: "#1c1c1c",
  accentForeground: "#f0eee8",
  // Match the background so the flat blob disappears into the surface.
  gradientAnchor: "#0a0a0a",
};

const theme: Theme = {
  id: "noir",
  name: "Noir",
  forcedMode: "dark",
  light: noir,
  dark: noir,
};

export default theme;
