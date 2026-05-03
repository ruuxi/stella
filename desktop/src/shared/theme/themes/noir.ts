import type { Theme, ThemeColors } from "./types";

// Noir is a standardized "black" theme. It is pinned to dark appearance
// and ignores the gradient controls — same single palette regardless of
// system Light/Dark or gradient settings. Background is the canonical
// near-black that companies like Vercel and Linear use rather than pure
// #000000, which avoids OLED smear and reads as "true dark mode".
const noir: ThemeColors = {
  background: "#0a0a0a",
  backgroundWeak: "#000000",
  backgroundStrong: "#141414",
  foreground: "#ededed",
  foregroundWeak: "#8a8a8a",
  foregroundStrong: "#ffffff",
  primary: "#ededed",
  primaryForeground: "#0a0a0a",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",
  info: "#60a5fa",
  interactive: "#ededed",
  border: "#1f1f1f",
  borderWeak: "#141414",
  borderStrong: "#2e2e2e",
  card: "rgba(20, 20, 20, 0.9)",
  cardForeground: "#ededed",
  muted: "#141414",
  mutedForeground: "#8a8a8a",
  accent: "#1a1a1a",
  accentForeground: "#ededed",
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
