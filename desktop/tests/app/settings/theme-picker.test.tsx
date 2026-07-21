// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ThemeState = {
  selectedThemeId: string;
  themes: Array<{ id: string; name: string }>;
  colorMode: "light" | "dark" | "system";
  gradientMode: "soft" | "flat";
  gradientColor: "relative" | "strong";
  flat: boolean;
};

let themeState: ThemeState;
const setTheme = vi.fn();
const setColorMode = vi.fn();
const setGradientMode = vi.fn();
const setGradientColor = vi.fn();
const previewTheme = vi.fn();
const cancelThemePreview = vi.fn();
const cancelPreview = vi.fn();

vi.mock("@/context/theme-context", () => ({
  useTheme: () => themeState,
  useThemeControl: () => ({
    setTheme,
    setColorMode,
    setGradientMode,
    setGradientColor,
    previewTheme,
    cancelThemePreview,
    cancelPreview,
  }),
}));

vi.mock("@/shared/theme/themes", () => ({
  isHiddenOverlay: () => false,
}));

vi.mock("@/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => children,
  PopoverBody: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/ui/icons", () => ({
  Check: () => <span data-testid="check" />,
}));

import { ThemePicker } from "@/global/settings/ThemePicker";

const findButton = (container: HTMLElement, label: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
};

describe("ThemePicker gradient controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    themeState = {
      selectedThemeId: "default",
      themes: [
        { id: "default", name: "Default" },
        { id: "custom", name: "Custom" },
      ],
      colorMode: "light",
      gradientMode: "flat",
      gradientColor: "strong",
      flat: true,
    };
    vi.clearAllMocks();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderPicker = async () => {
    await act(async () => {
      root.render(<ThemePicker open onOpenChange={vi.fn()} />);
    });
  };

  it("keeps saved gradient choices visible but disabled for Default", async () => {
    await renderPicker();

    expect(container.textContent).toContain("Gradient Style");
    expect(container.textContent).toContain("Gradient Color");

    const group = container.querySelector('[role="group"][aria-label="Gradient controls"]');
    expect(group?.getAttribute("aria-disabled")).toBe("true");
    expect(group?.hasAttribute("data-disabled")).toBe(true);

    for (const label of ["Soft", "Flat", "Relative", "Strong"]) {
      const button = findButton(container, label);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      button.click();
    }

    expect(findButton(container, "Flat").dataset.variant).toBe("secondary");
    expect(findButton(container, "Strong").dataset.variant).toBe("secondary");
    expect(setGradientMode).not.toHaveBeenCalled();
    expect(setGradientColor).not.toHaveBeenCalled();
  });

  it("re-enables the preserved choices after leaving Default", async () => {
    await renderPicker();

    await act(async () => {
      findButton(container, "Custom").click();
    });
    expect(setTheme).toHaveBeenCalledWith("custom");

    themeState = {
      ...themeState,
      selectedThemeId: "custom",
      flat: false,
    };
    await renderPicker();

    const group = container.querySelector('[role="group"][aria-label="Gradient controls"]');
    expect(group?.hasAttribute("aria-disabled")).toBe(false);
    expect(group?.hasAttribute("data-disabled")).toBe(false);
    expect(findButton(container, "Flat").dataset.variant).toBe("secondary");
    expect(findButton(container, "Strong").dataset.variant).toBe("secondary");

    const soft = findButton(container, "Soft");
    const relative = findButton(container, "Relative");
    expect(soft.disabled).toBe(false);
    expect(relative.disabled).toBe(false);

    await act(async () => {
      soft.click();
      relative.click();
    });
    expect(setGradientMode).toHaveBeenCalledWith("soft");
    expect(setGradientColor).toHaveBeenCalledWith("relative");
  });
});
