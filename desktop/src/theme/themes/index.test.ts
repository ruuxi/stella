import { describe, expect, it, beforeEach } from "vitest";
import { themes, getThemeById, defaultTheme, registerTheme, unregisterTheme } from "./index";
import type { Theme, ThemeColors } from "./types";

const makeColors = (bg: string): ThemeColors => ({
  background: bg,
  backgroundWeak: bg,
  backgroundStrong: bg,
  foreground: "#fff",
  foregroundWeak: "#ccc",
  foregroundStrong: "#fff",
  card: "#111",
  cardForeground: "#fff",
  primary: "#3b82f6",
  primaryForeground: "#fff",
  muted: "#333",
  mutedForeground: "#999",
  accent: "#444",
  accentForeground: "#fff",
  border: "#555",
  borderWeak: "#444",
  borderStrong: "#666",
  interactive: "#3b82f6",
  success: "#22c55e",
  warning: "#eab308",
  error: "#ef4444",
  info: "#06b6d4",
});

const testTheme: Theme = {
  id: "test-theme-unique",
  name: "Test Theme",
  light: makeColors("#ffffff"),
  dark: makeColors("#000000"),
};

describe("themes registry", () => {
  beforeEach(() => {
    // Clean up test theme if present from a previous run
    const idx = themes.findIndex((t) => t.id === testTheme.id);
    if (idx >= 0) themes.splice(idx, 1);
  });

  it("contains built-in themes", () => {
    expect(themes.length).toBeGreaterThanOrEqual(15);
  });

  it("getThemeById finds a known theme", () => {
    const found = getThemeById("carbonfox");
    expect(found).toBeDefined();
    expect(found?.name).toBe("Carbon");
  });

  it("getThemeById returns undefined for unknown id", () => {
    expect(getThemeById("nonexistent-theme-id")).toBeUndefined();
  });

  it("defaultTheme is carbonfox", () => {
    expect(defaultTheme.id).toBe("carbonfox");
  });

  describe("registerTheme", () => {
    it("adds a new theme", () => {
      registerTheme(testTheme);
      expect(getThemeById("test-theme-unique")).toBeDefined();
      // cleanup
      unregisterTheme("test-theme-unique");
    });

    it("replaces an existing theme with the same id", () => {
      registerTheme(testTheme);
      const updated: Theme = { ...testTheme, name: "Updated Name" };
      registerTheme(updated);
      expect(getThemeById("test-theme-unique")?.name).toBe("Updated Name");
      // The array length should not have grown by 2
      const matchCount = themes.filter((t) => t.id === "test-theme-unique").length;
      expect(matchCount).toBe(1);
      // cleanup
      unregisterTheme("test-theme-unique");
    });
  });

  describe("unregisterTheme", () => {
    it("removes a registered theme", () => {
      registerTheme(testTheme);
      expect(getThemeById("test-theme-unique")).toBeDefined();
      unregisterTheme("test-theme-unique");
      expect(getThemeById("test-theme-unique")).toBeUndefined();
    });

    it("does nothing for a non-existent id", () => {
      const before = themes.length;
      unregisterTheme("does-not-exist-12345");
      expect(themes.length).toBe(before);
    });
  });
});
