import type { Theme, ThemeColors } from "./types";

// Pearl is a standardized "white" theme. It is pinned to light appearance
// and ignores the gradient controls — same single palette regardless of
// system Light/Dark or gradient settings. Background is the canonical
// off-white that companies like Linear, Notion, and Stripe use rather
// than pure #ffffff for the entire surface.
const pearl: ThemeColors = {
  background: "#ffffff",
  backgroundWeak: "#ffffff",
  backgroundStrong: "#ffffff",
  foreground: "#111111",
  foregroundWeak: "#737373",
  foregroundStrong: "#000000",
  primary: "#2563eb",
  primaryForeground: "#ffffff",
  success: "#16a34a",
  warning: "#a16207",
  error: "#dc2626",
  info: "#2563eb",
  interactive: "#2563eb",
  border: "#ededed",
  borderWeak: "#f5f5f5",
  borderStrong: "#dcdcdc",
  card: "rgba(255, 255, 255, 0.96)",
  cardForeground: "#111111",
  muted: "#f7f7f7",
  mutedForeground: "#737373",
  accent: "#f4f4f4",
  accentForeground: "#111111",
  // Match the background so the flat blob disappears into the surface.
  gradientAnchor: "#ffffff",
};

const theme: Theme = {
  id: "pearl",
  name: "Pearl",
  forcedMode: "light",
  light: pearl,
  dark: pearl,
};

export default theme;
