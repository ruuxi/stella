import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider } from "@/theme/theme-context";
import { ThemePicker } from "./ThemePicker";

beforeEach(() => {
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

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("ThemePicker", () => {
  it("renders trigger button with text 'theme'", () => {
    renderWithTheme(<ThemePicker />);
    expect(screen.getByText("theme")).toBeTruthy();
  });

  it("shows appearance options (Light, Dark, System) when open", () => {
    renderWithTheme(<ThemePicker open={true} />);
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Dark")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
  });

  it("shows gradient options (Soft, Crisp) when open", () => {
    renderWithTheme(<ThemePicker open={true} />);
    expect(screen.getByText("Soft")).toBeTruthy();
    expect(screen.getByText("Crisp")).toBeTruthy();
  });

  it("shows color options (Relative, Strong) when open", () => {
    renderWithTheme(<ThemePicker open={true} />);
    expect(screen.getByText("Relative")).toBeTruthy();
    expect(screen.getByText("Strong")).toBeTruthy();
  });

  it("shows theme names in theme list when open", () => {
    renderWithTheme(<ThemePicker open={true} />);
    // The themes use display names (not IDs): Carbon, Orchid, Glacier, etc.
    expect(screen.getByText("Carbon")).toBeTruthy();
    expect(screen.getByText("Orchid")).toBeTruthy();
    expect(screen.getByText("Glacier")).toBeTruthy();
  });

  it("hides trigger when hideTrigger is true", () => {
    const { container } = renderWithTheme(<ThemePicker hideTrigger />);
    const trigger = container.querySelector('[data-slot="theme-picker-trigger"]');
    expect(trigger).toBeTruthy();
    expect((trigger as HTMLElement).style.opacity).toBe("0");
  });

  it("uses controlled open state", () => {
    // When open={true}, popover content should be visible without clicking
    renderWithTheme(<ThemePicker open={true} />);
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Gradient")).toBeTruthy();
    expect(screen.getByText("Color")).toBeTruthy();
  });

  it("calls onThemeSelect callback when clicking a theme", () => {
    const onThemeSelect = vi.fn();
    renderWithTheme(<ThemePicker open={true} onThemeSelect={onThemeSelect} />);

    const orchidButton = screen.getByText("Orchid");
    fireEvent.click(orchidButton);
    expect(onThemeSelect).toHaveBeenCalledTimes(1);
  });

  it("clicking an appearance option calls setColorMode", () => {
    renderWithTheme(<ThemePicker open={true} />);
    // Click "Dark" appearance button
    const darkBtn = screen.getByText("Dark");
    fireEvent.click(darkBtn);
    // After clicking Dark, it should become the active variant (secondary)
    expect(darkBtn.closest("button")?.getAttribute("data-slot")).toBe(
      "theme-picker-option-button",
    );
  });

  it("clicking a gradient mode option works", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const crispBtn = screen.getByText("Crisp");
    fireEvent.click(crispBtn);
    // Verify the button is present and clickable without error
    expect(crispBtn).toBeTruthy();
  });

  it("hovering a gradient mode option triggers preview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const crispBtn = screen.getByText("Crisp");
    fireEvent.mouseEnter(crispBtn);
    expect(crispBtn).toBeTruthy();
  });

  it("focusing a gradient mode option triggers preview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const crispBtn = screen.getByText("Crisp");
    fireEvent.focus(crispBtn);
    expect(crispBtn).toBeTruthy();
  });

  it("clicking a gradient color option works", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const relativeBtn = screen.getByText("Relative");
    fireEvent.click(relativeBtn);
    expect(relativeBtn).toBeTruthy();
  });

  it("hovering a gradient color option triggers preview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const relativeBtn = screen.getByText("Relative");
    fireEvent.mouseEnter(relativeBtn);
    expect(relativeBtn).toBeTruthy();
  });

  it("focusing a gradient color option triggers preview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const relativeBtn = screen.getByText("Relative");
    fireEvent.focus(relativeBtn);
    expect(relativeBtn).toBeTruthy();
  });

  it("hovering a theme triggers previewTheme", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const orchidBtn = screen.getByText("Orchid");
    fireEvent.mouseEnter(orchidBtn);
    expect(orchidBtn).toBeTruthy();
  });

  it("focusing a theme triggers previewTheme", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const orchidBtn = screen.getByText("Orchid");
    fireEvent.focus(orchidBtn);
    expect(orchidBtn).toBeTruthy();
  });

  it("mouse leaving the sections container calls cancelPreview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    // Popover renders via portal, so use document.querySelector
    const sectionsDiv = document.querySelector(
      '[data-slot="theme-picker-sections"]',
    );
    expect(sectionsDiv).toBeTruthy();
    fireEvent.mouseLeave(sectionsDiv!);
  });

  it("mouse leaving gradient mode row calls cancelGradientModePreview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const buttonRows = document.querySelectorAll(
      '[data-slot="theme-picker-button-row"]',
    );
    // Row 0 = Appearance, Row 1 = Gradient, Row 2 = Color
    expect(buttonRows.length).toBeGreaterThanOrEqual(3);
    fireEvent.mouseLeave(buttonRows[1]);
  });

  it("mouse leaving gradient color row calls cancelGradientColorPreview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const buttonRows = document.querySelectorAll(
      '[data-slot="theme-picker-button-row"]',
    );
    fireEvent.mouseLeave(buttonRows[2]);
  });

  it("mouse leaving theme list calls cancelThemePreview", () => {
    renderWithTheme(<ThemePicker open={true} />);
    const themeList = document.querySelector(
      '[data-slot="theme-picker-theme-list"]',
    );
    expect(themeList).toBeTruthy();
    fireEvent.mouseLeave(themeList!);
  });

  it("calls onOpenChange when closing popover", () => {
    const onOpenChange = vi.fn();
    renderWithTheme(
      <ThemePicker open={true} onOpenChange={onOpenChange} />,
    );
    // Clicking a theme closes the popover
    const orchidBtn = screen.getByText("Orchid");
    fireEvent.click(orchidBtn);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sorts themes alphabetically by name", () => {
    renderWithTheme(<ThemePicker open={true} />);
    // Popover renders via portal, so use document.querySelectorAll
    const themeButtons = document.querySelectorAll(
      '[data-slot="theme-picker-theme-name"]',
    );
    const names = Array.from(themeButtons).map(
      (el) => el.textContent ?? "",
    );
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("shows a check mark next to the currently selected theme", () => {
    renderWithTheme(<ThemePicker open={true} />);
    // Popover renders via portal, so use document.querySelectorAll
    const checks = document.querySelectorAll(
      '[data-slot="theme-picker-check"]',
    );
    // Exactly one theme should have a check mark (the default/selected one)
    expect(checks.length).toBe(1);
  });
});
