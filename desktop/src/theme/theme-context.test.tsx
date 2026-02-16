import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { ThemeProvider, useTheme } from "./theme-context";
import type { ThemeColors } from "./themes";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);

describe("ThemeProvider + useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    // Mock matchMedia for jsdom
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    localStorage.clear();
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("provides default theme (carbonfox)", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.themeId).toBe("carbonfox");
    expect(result.current.theme.id).toBe("carbonfox");
  });

  it("resolves colors based on color mode", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    // Default colorMode is "light"
    expect(result.current.resolvedColorMode).toBe("light");
    expect(result.current.colors).toBe(result.current.theme.light);
  });

  it("setTheme changes the active theme", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme("dracula");
    });

    expect(result.current.themeId).toBe("dracula");
    expect(result.current.theme.id).toBe("dracula");
    expect(localStorage.getItem("stella-theme-id")).toBe("dracula");
  });

  it("setColorMode persists to localStorage", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setColorMode("dark");
    });

    expect(result.current.colorMode).toBe("dark");
    expect(result.current.resolvedColorMode).toBe("dark");
    expect(localStorage.getItem("stella-color-mode")).toBe("dark");
  });

  it("setGradientMode persists to localStorage", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setGradientMode("crisp");
    });

    expect(result.current.gradientMode).toBe("crisp");
    expect(localStorage.getItem("stella-gradient-mode")).toBe("crisp");
  });

  it("setGradientColor persists to localStorage", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setGradientColor("relative");
    });

    expect(result.current.gradientColor).toBe("relative");
    expect(localStorage.getItem("stella-gradient-color")).toBe("relative");
  });

  it("reads initial state from localStorage", () => {
    localStorage.setItem("stella-theme-id", "nord");
    localStorage.setItem("stella-color-mode", "dark");
    localStorage.setItem("stella-gradient-mode", "crisp");
    localStorage.setItem("stella-gradient-color", "relative");

    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(result.current.themeId).toBe("nord");
    expect(result.current.colorMode).toBe("dark");
    expect(result.current.gradientMode).toBe("crisp");
    expect(result.current.gradientColor).toBe("relative");
  });

  it("falls back to default if localStorage theme id is invalid", () => {
    localStorage.setItem("stella-theme-id", "nonexistent-theme");

    const { result } = renderHook(() => useTheme(), { wrapper });
    // Falls back to defaultTheme since getThemeById returns undefined
    expect(result.current.theme.id).toBe("carbonfox");
  });

  describe("preview functions", () => {
    it("previewTheme shows preview colors without persisting", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewTheme("dracula");
      });

      // Theme shows preview
      expect(result.current.theme.id).toBe("dracula");
      // But themeId stays the same (not persisted)
      expect(result.current.themeId).toBe("carbonfox");
      expect(localStorage.getItem("stella-theme-id")).toBeNull();
    });

    it("cancelThemePreview reverts to actual theme", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewTheme("dracula");
      });
      expect(result.current.theme.id).toBe("dracula");

      act(() => {
        result.current.cancelThemePreview();
      });
      expect(result.current.theme.id).toBe("carbonfox");
    });

    it("previewTheme with invalid id is ignored", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewTheme("nonexistent");
      });

      // Should stay on current theme
      expect(result.current.theme.id).toBe("carbonfox");
    });

    it("cancelPreview clears all preview states", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewTheme("dracula");
        result.current.previewGradientMode("crisp");
        result.current.previewGradientColor("relative");
      });

      act(() => {
        result.current.cancelPreview();
      });

      expect(result.current.theme.id).toBe("carbonfox");
      expect(result.current.gradientMode).toBe("soft");
      expect(result.current.gradientColor).toBe("strong");
    });

    it("previewGradientMode shows preview without persisting", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewGradientMode("crisp");
      });

      expect(result.current.gradientMode).toBe("crisp");
      expect(localStorage.getItem("stella-gradient-mode")).toBeNull();
    });

    it("cancelGradientModePreview reverts", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewGradientMode("crisp");
      });
      act(() => {
        result.current.cancelGradientModePreview();
      });

      expect(result.current.gradientMode).toBe("soft");
    });

    it("previewGradientColor shows preview without persisting", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewGradientColor("relative");
      });

      expect(result.current.gradientColor).toBe("relative");
      expect(localStorage.getItem("stella-gradient-color")).toBeNull();
    });

    it("cancelGradientColorPreview reverts", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.previewGradientColor("relative");
      });
      act(() => {
        result.current.cancelGradientColorPreview();
      });

      expect(result.current.gradientColor).toBe("strong");
    });
  });

  it("exposes themes array", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(Array.isArray(result.current.themes)).toBe(true);
    expect(result.current.themes.length).toBeGreaterThanOrEqual(15);
  });

  it("dark mode resolves to dark colors", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setColorMode("dark");
    });

    expect(result.current.colors).toBe(result.current.theme.dark);
  });

  it("setTheme clears preview", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.previewTheme("dracula");
    });
    expect(result.current.theme.id).toBe("dracula");

    act(() => {
      result.current.setTheme("nord");
    });

    expect(result.current.themeId).toBe("nord");
    expect(result.current.theme.id).toBe("nord");
  });

  it("broadcasts theme change to electronAPI when setting theme", () => {
    const broadcastThemeChange = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      broadcastThemeChange,
      onThemeChange: vi.fn(() => vi.fn()),
      listInstalledThemes: vi.fn(() => Promise.resolve([])),
    };

    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme("dracula");
    });

    expect(broadcastThemeChange).toHaveBeenCalledWith(
      "stella-theme-id",
      "dracula",
    );
  });

  it("broadcasts color mode change to electronAPI", () => {
    const broadcastThemeChange = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      broadcastThemeChange,
      onThemeChange: vi.fn(() => vi.fn()),
      listInstalledThemes: vi.fn(() => Promise.resolve([])),
    };

    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setColorMode("dark");
    });

    expect(broadcastThemeChange).toHaveBeenCalledWith(
      "stella-color-mode",
      "dark",
    );
  });

  it("broadcasts gradient mode change to electronAPI", () => {
    const broadcastThemeChange = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      broadcastThemeChange,
      onThemeChange: vi.fn(() => vi.fn()),
      listInstalledThemes: vi.fn(() => Promise.resolve([])),
    };

    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setGradientMode("crisp");
    });

    expect(broadcastThemeChange).toHaveBeenCalledWith(
      "stella-gradient-mode",
      "crisp",
    );
  });

  it("broadcasts gradient color change to electronAPI", () => {
    const broadcastThemeChange = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      broadcastThemeChange,
      onThemeChange: vi.fn(() => vi.fn()),
      listInstalledThemes: vi.fn(() => Promise.resolve([])),
    };

    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setGradientColor("relative");
    });

    expect(broadcastThemeChange).toHaveBeenCalledWith(
      "stella-gradient-color",
      "relative",
    );
  });

  it("loads installed themes from electronAPI on mount", async () => {
    const fakeTheme = {
      id: "custom-theme",
      name: "Custom",
      light: {} as ThemeColors,
      dark: {} as ThemeColors,
    };
    const listInstalledThemes = vi.fn(() => Promise.resolve([fakeTheme]));
    (window as unknown as Record<string, unknown>).electronAPI = {
      listInstalledThemes,
      onThemeChange: vi.fn(() => vi.fn()),
      broadcastThemeChange: vi.fn(),
    };

    renderHook(() => useTheme(), { wrapper });

    await vi.waitFor(() => {
      expect(listInstalledThemes).toHaveBeenCalled();
    });
  });

  it("ignores errors when loading installed themes", async () => {
    const listInstalledThemes = vi.fn(() =>
      Promise.reject(new Error("no dir")),
    );
    (window as unknown as Record<string, unknown>).electronAPI = {
      listInstalledThemes,
      onThemeChange: vi.fn(() => vi.fn()),
      broadcastThemeChange: vi.fn(),
    };

    // Should not throw
    renderHook(() => useTheme(), { wrapper });

    await vi.waitFor(() => {
      expect(listInstalledThemes).toHaveBeenCalled();
    });
  });

  it("responds to IPC theme change events", () => {
    let ipcCallback: ((event: unknown, data: { key: string; value: string }) => void) | null = null;
    const onThemeChange = vi.fn((cb: (event: unknown, data: { key: string; value: string }) => void) => {
      ipcCallback = cb;
      return vi.fn(); // unsubscribe
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      onThemeChange,
      broadcastThemeChange: vi.fn(),
      listInstalledThemes: vi.fn(() => Promise.resolve([])),
    };

    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(onThemeChange).toHaveBeenCalled();

    // Simulate theme change from another window
    act(() => {
      ipcCallback?.(null, { key: "stella-theme-id", value: "nord" });
    });
    expect(result.current.themeId).toBe("nord");

    // Simulate color mode change
    act(() => {
      ipcCallback?.(null, { key: "stella-color-mode", value: "dark" });
    });
    expect(result.current.colorMode).toBe("dark");

    // Simulate gradient mode change
    act(() => {
      ipcCallback?.(null, { key: "stella-gradient-mode", value: "crisp" });
    });
    expect(result.current.gradientMode).toBe("crisp");

    // Simulate gradient color change
    act(() => {
      ipcCallback?.(null, { key: "stella-gradient-color", value: "relative" });
    });
    expect(result.current.gradientColor).toBe("relative");
  });

  it("responds to localStorage storage events", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "stella-theme-id",
          newValue: "nord",
        }),
      );
    });
    expect(result.current.themeId).toBe("nord");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "stella-color-mode",
          newValue: "dark",
        }),
      );
    });
    expect(result.current.colorMode).toBe("dark");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "stella-gradient-mode",
          newValue: "crisp",
        }),
      );
    });
    expect(result.current.gradientMode).toBe("crisp");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "stella-gradient-color",
          newValue: "relative",
        }),
      );
    });
    expect(result.current.gradientColor).toBe("relative");
  });

  it("ignores storage events with null newValue", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "stella-theme-id",
          newValue: null,
        }),
      );
    });
    // Should remain unchanged
    expect(result.current.themeId).toBe("carbonfox");
  });

  it("resolves system color mode when colorMode is 'system'", () => {
    // matchMedia returns matches: false (light), so system mode is "light"
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setColorMode("system");
    });

    expect(result.current.colorMode).toBe("system");
    expect(result.current.resolvedColorMode).toBe("light");
  });

  it("resolves system dark mode when matchMedia reports dark", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-color-scheme: dark)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setColorMode("system");
    });

    expect(result.current.resolvedColorMode).toBe("dark");
  });

  it("setGradientMode clears preview state", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.previewGradientMode("crisp");
    });
    expect(result.current.gradientMode).toBe("crisp");

    act(() => {
      result.current.setGradientMode("soft");
    });
    expect(result.current.gradientMode).toBe("soft");
    expect(localStorage.getItem("stella-gradient-mode")).toBe("soft");
  });

  it("setGradientColor clears preview state", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.previewGradientColor("relative");
    });
    expect(result.current.gradientColor).toBe("relative");

    act(() => {
      result.current.setGradientColor("strong");
    });
    expect(result.current.gradientColor).toBe("strong");
    expect(localStorage.getItem("stella-gradient-color")).toBe("strong");
  });
});

describe("useTheme outside provider", () => {
  it("throws when used outside ThemeProvider", () => {
    expect(() => {
      renderHook(() => useTheme());
    }).toThrow("useTheme must be used within a ThemeProvider");
  });
});
