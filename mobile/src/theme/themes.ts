/**
 * All 17 Stella themes, ported from the desktop app.
 * Each theme provides light + dark color palettes mapped to the mobile Colors type.
 * Derived values (accentSoft, overlay) computed via OKLCH for perceptual accuracy.
 */
import type { Colors } from "./colors";
import { soften } from "./oklch";

export type StellaTheme = {
  id: string;
  name: string;
  light: Colors;
  dark: Colors;
};

/** Full desktop ThemeColors — we map every field. */
type Src = {
  background: string;
  backgroundWeak: string;
  backgroundStrong: string;
  foreground: string;
  foregroundWeak: string;
  foregroundStrong: string;
  primary: string;
  primaryForeground: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  interactive: string;
  border: string;
  borderWeak: string;
  borderStrong: string;
  card: string;
  cardForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
};

function map(s: Src, isDark: boolean): Colors {
  return {
    background: s.background,
    backgroundWeak: s.backgroundWeak,
    backgroundStrong: s.backgroundStrong,
    surface: isDark ? s.backgroundWeak : s.backgroundStrong,
    panel: s.muted,

    border: s.border,
    borderWeak: s.borderWeak,
    borderStrong: s.borderStrong,

    text: s.foreground,
    textMuted: s.foregroundWeak,
    textStrong: s.foregroundStrong,

    accent: s.primary,
    accentHover: s.interactive,
    accentSoft: soften(s.primary, s.background, 0.12),
    accentForeground: s.primaryForeground,

    decorative: s.accent,
    decorativeForeground: s.accentForeground,

    ok: s.success,
    warning: s.warning,
    danger: s.error,
    info: s.info,

    card: s.card,
    cardForeground: s.cardForeground,
    muted: s.muted,
    mutedForeground: s.mutedForeground,

    overlay: soften(s.foregroundStrong, s.background, 0.38),
  };
}

function th(id: string, name: string, l: Src, d: Src): StellaTheme {
  return { id, name, light: map(l, false), dark: map(d, true) };
}

// ---------------------------------------------------------------------------
// Theme definitions — colors from desktop/src/shared/theme/themes/*.ts
// ---------------------------------------------------------------------------

export const themes: StellaTheme[] = [
  th("carbonfox", "Carbon",
    { background: "#f2f4f8", backgroundWeak: "#e8ebf0", backgroundStrong: "#f8f9fb", foreground: "#161616", foregroundWeak: "#4d5358", foregroundStrong: "#000000", primary: "#0f62fe", primaryForeground: "#ffffff", success: "#42be65", warning: "#f1c21b", error: "#da1e28", info: "#4589ff", interactive: "#0f62fe", border: "#c1c7cd", borderWeak: "#dde1e6", borderStrong: "#878d96", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#161616", muted: "#dde1e6", mutedForeground: "#4d5358", accent: "#ee5396", accentForeground: "#ffffff" },
    { background: "#161616", backgroundWeak: "#1c1c1c", backgroundStrong: "#0f0f0f", foreground: "#f2f4f8", foregroundWeak: "#b8bfc7", foregroundStrong: "#ffffff", primary: "#78a9ff", primaryForeground: "#161616", success: "#42be65", warning: "#f1c21b", error: "#ff8389", info: "#4589ff", interactive: "#78a9ff", border: "#393939", borderWeak: "#262626", borderStrong: "#525252", card: "rgba(38, 38, 38, 0.9)", cardForeground: "#f2f4f8", muted: "#262626", mutedForeground: "#b8bfc7", accent: "#ff7eb6", accentForeground: "#161616" },
  ),
  th("pearl", "Pearl",
    { background: "#ffffff", backgroundWeak: "#f7f7f7", backgroundStrong: "#ffffff", foreground: "#1a1a1a", foregroundWeak: "#6b6b6b", foregroundStrong: "#0a0a0a", primary: "#2563eb", primaryForeground: "#ffffff", success: "#22863a", warning: "#b08600", error: "#d1242f", info: "#0ea5e9", interactive: "#2563eb", border: "#e5e5e5", borderWeak: "#f0f0f0", borderStrong: "#d4d4d4", card: "rgba(255, 255, 255, 0.88)", cardForeground: "#1a1a1a", muted: "#f5f5f5", mutedForeground: "#737373", accent: "#f0f0f0", accentForeground: "#1a1a1a" },
    { background: "#161616", backgroundWeak: "#1c1c1c", backgroundStrong: "#111111", foreground: "#e5e5e5", foregroundWeak: "#a0a0a0", foregroundStrong: "#fafafa", primary: "#3b82f6", primaryForeground: "#ffffff", success: "#3fb950", warning: "#d29922", error: "#f85149", info: "#38bdf8", interactive: "#3b82f6", border: "#2e2e2e", borderWeak: "#232323", borderStrong: "#424242", card: "rgba(28, 28, 28, 0.85)", cardForeground: "#e5e5e5", muted: "#232323", mutedForeground: "#a0a0a0", accent: "#2a2a2a", accentForeground: "#e5e5e5" },
  ),
  th("noir", "Noir",
    { background: "#fafafa", backgroundWeak: "#f2f2f2", backgroundStrong: "#ffffff", foreground: "#171717", foregroundWeak: "#636363", foregroundStrong: "#050505", primary: "#404040", primaryForeground: "#fafafa", success: "#16a34a", warning: "#a16207", error: "#dc2626", info: "#2563eb", interactive: "#404040", border: "#e0e0e0", borderWeak: "#ececec", borderStrong: "#c8c8c8", card: "rgba(255, 255, 255, 0.88)", cardForeground: "#171717", muted: "#f0f0f0", mutedForeground: "#636363", accent: "#ebebeb", accentForeground: "#171717" },
    { background: "#000000", backgroundWeak: "#0a0a0a", backgroundStrong: "#000000", foreground: "#d4d4d4", foregroundWeak: "#808080", foregroundStrong: "#ffffff", primary: "#d4d4d4", primaryForeground: "#0a0a0a", success: "#4ade80", warning: "#fbbf24", error: "#f87171", info: "#60a5fa", interactive: "#a0a0a0", border: "#1f1f1f", borderWeak: "#141414", borderStrong: "#333333", card: "rgba(12, 12, 12, 0.85)", cardForeground: "#d4d4d4", muted: "#141414", mutedForeground: "#808080", accent: "#1a1a1a", accentForeground: "#d4d4d4" },
  ),
  th("oc-1", "Sandstone",
    { background: "#f8f7f7", backgroundWeak: "#f0eeee", backgroundStrong: "#fcfcfc", foreground: "#1c1712", foregroundWeak: "#5a5248", foregroundStrong: "#0a0806", primary: "#1c1712", primaryForeground: "#f7f2ea", success: "#4a9c3d", warning: "#c9922a", error: "#d94830", info: "#4a8eb5", interactive: "#034cff", border: "rgba(28, 23, 18, 0.12)", borderWeak: "rgba(28, 23, 18, 0.08)", borderStrong: "rgba(28, 23, 18, 0.18)", card: "rgba(255, 255, 255, 0.75)", cardForeground: "#1c1712", muted: "#f0eeee", mutedForeground: "#6b6257", accent: "#dcde8d", accentForeground: "#1c1712" },
    { background: "#1a1614", backgroundWeak: "#1c1717", backgroundStrong: "#151313", foreground: "#e8e3dc", foregroundWeak: "#a09891", foregroundStrong: "#f7f2ea", primary: "#f7f2ea", primaryForeground: "#1c1712", success: "#6ab85e", warning: "#e0a840", error: "#e05a42", info: "#8cb8d4", interactive: "#4a7fff", border: "rgba(255, 255, 255, 0.12)", borderWeak: "rgba(255, 255, 255, 0.08)", borderStrong: "rgba(255, 255, 255, 0.18)", card: "rgba(40, 35, 32, 0.75)", cardForeground: "#e8e3dc", muted: "#2a2522", mutedForeground: "#8a8078", accent: "#fab283", accentForeground: "#1c1712" },
  ),
  th("tokyonight", "Twilight",
    { background: "#e1e6f6", backgroundWeak: "#d5ddf0", backgroundStrong: "#ebf0fb", foreground: "#273153", foregroundWeak: "#5c6390", foregroundStrong: "#1c2544", primary: "#2e7de9", primaryForeground: "#ffffff", success: "#4a7a3a", warning: "#a07832", error: "#c94060", info: "#007197", interactive: "#2e7de9", border: "#b8bccc", borderWeak: "#d8dbe7", borderStrong: "#858a9e", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#273153", muted: "#dde0ec", mutedForeground: "#5c6390", accent: "#9854f1", accentForeground: "#ffffff" },
    { background: "#0f111a", backgroundWeak: "#111428", backgroundStrong: "#101324", foreground: "#c0caf5", foregroundWeak: "#7a88cf", foregroundStrong: "#eaeaff", primary: "#7aa2f7", primaryForeground: "#0f111a", success: "#9ece6a", warning: "#e0af68", error: "#f7768e", info: "#7dcfff", interactive: "#7aa2f7", border: "#3a3e57", borderWeak: "#25283b", borderStrong: "#5a5f82", card: "rgba(31, 35, 53, 0.9)", cardForeground: "#c0caf5", muted: "#24283b", mutedForeground: "#7a88cf", accent: "#bb9af7", accentForeground: "#0f111a" },
  ),
  th("dracula", "Orchid",
    { background: "#eee8ff", backgroundWeak: "#e2daf8", backgroundStrong: "#f6f2ff", foreground: "#1f1f2f", foregroundWeak: "#52526b", foregroundStrong: "#05040c", primary: "#7c6bf5", primaryForeground: "#ffffff", success: "#2fbf71", warning: "#f7a14d", error: "#d9536f", info: "#1d7fc5", interactive: "#7c6bf5", border: "#c4c6ba", borderWeak: "#e2e3da", borderStrong: "#9fa293", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#1f1f2f", muted: "#e8e9e0", mutedForeground: "#52526b", accent: "#d16090", accentForeground: "#ffffff" },
    { background: "#14151f", backgroundWeak: "#181926", backgroundStrong: "#161722", foreground: "#f8f8f2", foregroundWeak: "#b6b9e4", foregroundStrong: "#ffffff", primary: "#bd93f9", primaryForeground: "#14151f", success: "#50fa7b", warning: "#ffb86c", error: "#ff5555", info: "#8be9fd", interactive: "#bd93f9", border: "#3f415a", borderWeak: "#2d2f3c", borderStrong: "#606488", card: "rgba(40, 42, 64, 0.9)", cardForeground: "#f8f8f2", muted: "#282a40", mutedForeground: "#b6b9e4", accent: "#ff79c6", accentForeground: "#14151f" },
  ),
  th("catppuccin", "Ros\u00e9",
    { background: "#f5e0dc", backgroundWeak: "#f2d8d4", backgroundStrong: "#f9e8e4", foreground: "#4c4f69", foregroundWeak: "#6c6f85", foregroundStrong: "#1f1f2a", primary: "#7287fd", primaryForeground: "#ffffff", success: "#40a02b", warning: "#df8e1d", error: "#d20f39", info: "#04a5e5", interactive: "#7287fd", border: "#bca6b2", borderWeak: "#e0cfd3", borderStrong: "#83677f", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#4c4f69", muted: "#eed5d0", mutedForeground: "#6c6f85", accent: "#ea76cb", accentForeground: "#ffffff" },
    { background: "#1e1e2e", backgroundWeak: "#211f31", backgroundStrong: "#1c1c29", foreground: "#cdd6f4", foregroundWeak: "#a6adc8", foregroundStrong: "#f4f2ff", primary: "#b4befe", primaryForeground: "#1e1e2e", success: "#a6d189", warning: "#f2c97d", error: "#f38ba8", info: "#89dceb", interactive: "#b4befe", border: "#4a4763", borderWeak: "#35324a", borderStrong: "#6e6a8c", card: "rgba(48, 46, 72, 0.9)", cardForeground: "#cdd6f4", muted: "#313244", mutedForeground: "#a6adc8", accent: "#f5c2e7", accentForeground: "#1e1e2e" },
  ),
  th("nord", "Glacier",
    { background: "#e2ecf8", backgroundWeak: "#d6e3f2", backgroundStrong: "#ebf3fb", foreground: "#2e3440", foregroundWeak: "#4c566a", foregroundStrong: "#1f2530", primary: "#5e81ac", primaryForeground: "#ffffff", success: "#8fbcbb", warning: "#d08770", error: "#bf616a", info: "#81a1c1", interactive: "#5e81ac", border: "#afb7cb", borderWeak: "#d5dbe7", borderStrong: "#757f97", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#2e3440", muted: "#d8dee9", mutedForeground: "#4c566a", accent: "#88c0d0", accentForeground: "#2e3440" },
    { background: "#1f2430", backgroundWeak: "#222938", backgroundStrong: "#1c202a", foreground: "#e5e9f0", foregroundWeak: "#a4adbf", foregroundStrong: "#f8fafc", primary: "#88c0d0", primaryForeground: "#1f2430", success: "#a3be8c", warning: "#d08770", error: "#bf616a", info: "#81a1c1", interactive: "#88c0d0", border: "#4a5163", borderWeak: "#343a47", borderStrong: "#6a7492", card: "rgba(46, 52, 64, 0.9)", cardForeground: "#e5e9f0", muted: "#3b4252", mutedForeground: "#a4adbf", accent: "#8fbcbb", accentForeground: "#1f2430" },
  ),
  th("monokai", "Neon",
    { background: "#eef6e3", backgroundWeak: "#e3eed5", backgroundStrong: "#f6faee", foreground: "#272822", foregroundWeak: "#75715e", foregroundStrong: "#1a1a16", primary: "#ae81ff", primaryForeground: "#ffffff", success: "#7da82a", warning: "#d48b1a", error: "#f92672", info: "#66d9ef", interactive: "#ae81ff", border: "#c8c8c4", borderWeak: "#e0e0dc", borderStrong: "#9e9e98", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#272822", muted: "#e8e8e4", mutedForeground: "#75715e", accent: "#fd971f", accentForeground: "#272822" },
    { background: "#272822", backgroundWeak: "#2d2e27", backgroundStrong: "#1e1f1c", foreground: "#f8f8f2", foregroundWeak: "#a8a8a0", foregroundStrong: "#ffffff", primary: "#ae81ff", primaryForeground: "#272822", success: "#a6e22e", warning: "#fd971f", error: "#f92672", info: "#66d9ef", interactive: "#ae81ff", border: "#49483e", borderWeak: "#3e3d32", borderStrong: "#6a6960", card: "rgba(62, 61, 50, 0.9)", cardForeground: "#f8f8f2", muted: "#3e3d32", mutedForeground: "#a8a8a0", accent: "#fd971f", accentForeground: "#272822" },
  ),
  th("solarized", "Solstice",
    { background: "#fdf6e3", backgroundWeak: "#f5efdc", backgroundStrong: "#fffbf0", foreground: "#4a6068", foregroundWeak: "#6e878c", foregroundStrong: "#073642", primary: "#268bd2", primaryForeground: "#ffffff", success: "#859900", warning: "#b58900", error: "#dc322f", info: "#2aa198", interactive: "#268bd2", border: "#d3cbb7", borderWeak: "#e8e2d0", borderStrong: "#a8a18c", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#657b83", muted: "#eee8d5", mutedForeground: "#839496", accent: "#6c71c4", accentForeground: "#ffffff" },
    { background: "#002b36", backgroundWeak: "#073642", backgroundStrong: "#001f27", foreground: "#93a1a1", foregroundWeak: "#748d95", foregroundStrong: "#fdf6e3", primary: "#268bd2", primaryForeground: "#002b36", success: "#859900", warning: "#b58900", error: "#dc322f", info: "#2aa198", interactive: "#268bd2", border: "#0a4050", borderWeak: "#073642", borderStrong: "#1a5a6e", card: "rgba(7, 54, 66, 0.9)", cardForeground: "#93a1a1", muted: "#073642", mutedForeground: "#748d95", accent: "#6c71c4", accentForeground: "#002b36" },
  ),
  th("onedarkpro", "Graphite",
    { background: "#e8edf3", backgroundWeak: "#dde4ec", backgroundStrong: "#f1f5f9", foreground: "#383a42", foregroundWeak: "#6b717d", foregroundStrong: "#1a1c20", primary: "#4078f2", primaryForeground: "#ffffff", success: "#50a14f", warning: "#c18401", error: "#e45649", info: "#0184bc", interactive: "#4078f2", border: "#c8c8c8", borderWeak: "#e0e0e0", borderStrong: "#9a9a9a", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#383a42", muted: "#e5e5e5", mutedForeground: "#6b717d", accent: "#a626a4", accentForeground: "#ffffff" },
    { background: "#282c34", backgroundWeak: "#2d313a", backgroundStrong: "#21252b", foreground: "#abb2bf", foregroundWeak: "#7f848e", foregroundStrong: "#e6e6e6", primary: "#61afef", primaryForeground: "#282c34", success: "#98c379", warning: "#e5c07b", error: "#e06c75", info: "#56b6c2", interactive: "#61afef", border: "#3e4451", borderWeak: "#2c313c", borderStrong: "#5c6370", card: "rgba(50, 56, 66, 0.9)", cardForeground: "#abb2bf", muted: "#3e4451", mutedForeground: "#7f848e", accent: "#c678dd", accentForeground: "#282c34" },
  ),
  th("shadesofpurple", "Amethyst",
    { background: "#f5f3ff", backgroundWeak: "#ede9ff", backgroundStrong: "#faf9ff", foreground: "#2d2b55", foregroundWeak: "#6a67a5", foregroundStrong: "#1a1837", primary: "#7b6dc8", primaryForeground: "#ffffff", success: "#2ab800", warning: "#d88600", error: "#d43835", info: "#0090d4", interactive: "#7b6dc8", border: "#c5c0e8", borderWeak: "#ddd9f5", borderStrong: "#9992c5", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#2d2b55", muted: "#e8e4fc", mutedForeground: "#6a67a5", accent: "#fad000", accentForeground: "#1a1837" },
    { background: "#1e1e3f", backgroundWeak: "#232350", backgroundStrong: "#181835", foreground: "#e7e7ff", foregroundWeak: "#a599e9", foregroundStrong: "#ffffff", primary: "#a599e9", primaryForeground: "#1e1e3f", success: "#3ad900", warning: "#ff9d00", error: "#ec3a37", info: "#00b0ff", interactive: "#a599e9", border: "#4e4e8a", borderWeak: "#38385e", borderStrong: "#6a6ab5", card: "rgba(45, 43, 85, 0.9)", cardForeground: "#e7e7ff", muted: "#2d2b55", mutedForeground: "#a599e9", accent: "#fad000", accentForeground: "#1e1e3f" },
  ),
  th("nightowl", "Midnight",
    { background: "#e7f1fb", backgroundWeak: "#dbe8f6", backgroundStrong: "#f2f8fd", foreground: "#403f53", foregroundWeak: "#716f8a", foregroundStrong: "#1a1a2e", primary: "#4876d6", primaryForeground: "#ffffff", success: "#08916a", warning: "#daaa01", error: "#de3d3b", info: "#0c969b", interactive: "#4876d6", border: "#c9c9c9", borderWeak: "#e0e0e0", borderStrong: "#9a9a9a", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#403f53", muted: "#e5e5e5", mutedForeground: "#716f8a", accent: "#c96765", accentForeground: "#ffffff" },
    { background: "#011627", backgroundWeak: "#021d32", backgroundStrong: "#00101e", foreground: "#d6deeb", foregroundWeak: "#8badc1", foregroundStrong: "#ffffff", primary: "#82aaff", primaryForeground: "#011627", success: "#22da6e", warning: "#ffeb95", error: "#ef5350", info: "#7fdbca", interactive: "#82aaff", border: "#1d3b53", borderWeak: "#122d42", borderStrong: "#2a4a66", card: "rgba(1, 42, 74, 0.9)", cardForeground: "#d6deeb", muted: "#0b2942", mutedForeground: "#8badc1", accent: "#c792ea", accentForeground: "#011627" },
  ),
  th("vesper", "Ember",
    { background: "#f4ebe1", backgroundWeak: "#e9ddd1", backgroundStrong: "#faf3ec", foreground: "#1f1d1b", foregroundWeak: "#5c5654", foregroundStrong: "#0a0908", primary: "#8b5cf6", primaryForeground: "#ffffff", success: "#22c55e", warning: "#f59e0b", error: "#ef4444", info: "#3b82f6", interactive: "#8b5cf6", border: "#d4cfc9", borderWeak: "#e8e4e0", borderStrong: "#a8a29e", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#1f1d1b", muted: "#e7e5e4", mutedForeground: "#5c5654", accent: "#fbbf24", accentForeground: "#1f1d1b" },
    { background: "#101010", backgroundWeak: "#171717", backgroundStrong: "#0a0a0a", foreground: "#e5e5e5", foregroundWeak: "#a3a3a3", foregroundStrong: "#ffffff", primary: "#a78bfa", primaryForeground: "#101010", success: "#4ade80", warning: "#fbbf24", error: "#f87171", info: "#60a5fa", interactive: "#a78bfa", border: "#2e2e2e", borderWeak: "#1f1f1f", borderStrong: "#454545", card: "rgba(28, 28, 28, 0.9)", cardForeground: "#e5e5e5", muted: "#1c1c1c", mutedForeground: "#a3a3a3", accent: "#fbbf24", accentForeground: "#101010" },
  ),
  th("gruvbox", "Autumn",
    { background: "#fbf1c7", backgroundWeak: "#f2e5bc", backgroundStrong: "#fffbeb", foreground: "#3c3836", foregroundWeak: "#665c54", foregroundStrong: "#1d2021", primary: "#d65d0e", primaryForeground: "#fbf1c7", success: "#98971a", warning: "#d79921", error: "#cc241d", info: "#458588", interactive: "#d65d0e", border: "#d5c4a1", borderWeak: "#ebdbb2", borderStrong: "#a89984", card: "rgba(255, 255, 255, 0.85)", cardForeground: "#3c3836", muted: "#ebdbb2", mutedForeground: "#665c54", accent: "#b16286", accentForeground: "#fbf1c7" },
    { background: "#282828", backgroundWeak: "#302e2d", backgroundStrong: "#1d2021", foreground: "#ebdbb2", foregroundWeak: "#a89984", foregroundStrong: "#fbf1c7", primary: "#fe8019", primaryForeground: "#282828", success: "#b8bb26", warning: "#fabd2f", error: "#fb4934", info: "#83a598", interactive: "#fe8019", border: "#3c3836", borderWeak: "#32302f", borderStrong: "#504945", card: "rgba(60, 56, 54, 0.9)", cardForeground: "#ebdbb2", muted: "#3c3836", mutedForeground: "#a89984", accent: "#d3869b", accentForeground: "#282828" },
  ),
  th("ayu", "Amber",
    { background: "#fafafa", backgroundWeak: "#f0f0f0", backgroundStrong: "#ffffff", foreground: "#575f66", foregroundWeak: "#8a919a", foregroundStrong: "#1a1f26", primary: "#ff9940", primaryForeground: "#1a1f26", success: "#86b300", warning: "#f29718", error: "#e4584a", info: "#55b4d4", interactive: "#ff9940", border: "#c9ccd0", borderWeak: "#e0e2e5", borderStrong: "#9a9fa5", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#575f66", muted: "#e7e8e9", mutedForeground: "#8a919a", accent: "#a37acc", accentForeground: "#ffffff" },
    { background: "#0a0e14", backgroundWeak: "#0d1117", backgroundStrong: "#050709", foreground: "#bfbdb6", foregroundWeak: "#6c7380", foregroundStrong: "#e6e1cf", primary: "#ffb454", primaryForeground: "#0a0e14", success: "#aad94c", warning: "#e8815c", error: "#f07178", info: "#59c2ff", interactive: "#ffb454", border: "#1f2430", borderWeak: "#151a22", borderStrong: "#2d3640", card: "rgba(18, 24, 32, 0.9)", cardForeground: "#bfbdb6", muted: "#131721", mutedForeground: "#6c7380", accent: "#d2a6ff", accentForeground: "#0a0e14" },
  ),
  th("aura", "Velvet",
    { background: "#f5f2ff", backgroundWeak: "#ece8fa", backgroundStrong: "#faf9ff", foreground: "#29263c", foregroundWeak: "#605d78", foregroundStrong: "#15131f", primary: "#a277ff", primaryForeground: "#ffffff", success: "#2ea88a", warning: "#d4943c", error: "#d94e4e", info: "#3a9bc5", interactive: "#a277ff", border: "#c8c3e0", borderWeak: "#ddd9f0", borderStrong: "#9d98b8", card: "rgba(255, 255, 255, 0.9)", cardForeground: "#29263c", muted: "#e8e4f5", mutedForeground: "#605d78", accent: "#d4943c", accentForeground: "#29263c" },
    { background: "#15141b", backgroundWeak: "#1a1921", backgroundStrong: "#0e0d12", foreground: "#edecee", foregroundWeak: "#9d9ba8", foregroundStrong: "#ffffff", primary: "#a277ff", primaryForeground: "#15141b", success: "#54deb0", warning: "#f0b86a", error: "#ff6767", info: "#6ecfef", interactive: "#a277ff", border: "#2d2b3a", borderWeak: "#21202a", borderStrong: "#433f55", card: "rgba(33, 32, 42, 0.9)", cardForeground: "#edecee", muted: "#21202a", mutedForeground: "#9d9ba8", accent: "#ffca85", accentForeground: "#15141b" },
  ),
];

export const defaultThemeId = "carbonfox";

export function getThemeById(id: string): StellaTheme | undefined {
  return themes.find((t) => t.id === id);
}
