import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingDiscovery } from "./OnboardingDiscovery";
import { DISCOVERY_CATEGORIES } from "./use-onboarding-state";
import type { DiscoveryCategory } from "./use-onboarding-state";

describe("OnboardingDiscovery", () => {
  const defaultCategoryStates: Record<DiscoveryCategory, boolean> = {
    dev_environment: false,
    apps_system: false,
    messages_notes: false,
  };

  beforeEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Basic rendering
  // ----------------------------------------------------------------
  it("renders a button for each discovery category", () => {
    const onToggle = vi.fn();
    render(
      <OnboardingDiscovery
        categoryStates={defaultCategoryStates}
        onToggleCategory={onToggle}
      />,
    );

    for (const cat of DISCOVERY_CATEGORIES) {
      expect(screen.getByText(cat.label)).toBeInTheDocument();
      expect(screen.getByText(cat.description)).toBeInTheDocument();
    }
  });

  it("renders with data-visible attribute set to true", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <OnboardingDiscovery
        categoryStates={defaultCategoryStates}
        onToggleCategory={onToggle}
      />,
    );

    const discovery = container.querySelector(".onboarding-discovery");
    expect(discovery).not.toBeNull();
    expect(discovery!.getAttribute("data-visible")).toBe("true");
  });

  // ----------------------------------------------------------------
  // Toggle interaction
  // ----------------------------------------------------------------
  it("calls onToggleCategory with the correct id when a category is clicked", () => {
    const onToggle = vi.fn();
    render(
      <OnboardingDiscovery
        categoryStates={defaultCategoryStates}
        onToggleCategory={onToggle}
      />,
    );

    for (const cat of DISCOVERY_CATEGORIES) {
      fireEvent.click(screen.getByText(cat.label));
      expect(onToggle).toHaveBeenCalledWith(cat.id);
    }

    expect(onToggle).toHaveBeenCalledTimes(DISCOVERY_CATEGORIES.length);
  });

  // ----------------------------------------------------------------
  // data-active attribute
  // ----------------------------------------------------------------
  it("sets data-active on category buttons based on categoryStates", () => {
    const onToggle = vi.fn();
    const states: Record<DiscoveryCategory, boolean> = {
      dev_environment: true,
      apps_system: false,
      messages_notes: true,
    };

    const { container } = render(
      <OnboardingDiscovery
        categoryStates={states}
        onToggleCategory={onToggle}
      />,
    );

    const buttons = container.querySelectorAll(".onboarding-discovery-row");
    expect(buttons.length).toBe(DISCOVERY_CATEGORIES.length);

    // Check each button's data-active matches the state for its category
    for (let i = 0; i < DISCOVERY_CATEGORIES.length; i++) {
      const cat = DISCOVERY_CATEGORIES[i];
      const button = buttons[i];
      expect(button.getAttribute("data-active")).toBe(
        String(states[cat.id]),
      );
    }
  });

  // ----------------------------------------------------------------
  // FDA note - not shown on non-darwin
  // ----------------------------------------------------------------
  it("does not show FDA note when platform is not darwin", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = { platform: "win32" };

    const states: Record<DiscoveryCategory, boolean> = {
      dev_environment: false,
      apps_system: true, // requiresFDA = true
      messages_notes: false,
    };

    const { container } = render(
      <OnboardingDiscovery
        categoryStates={states}
        onToggleCategory={vi.fn()}
      />,
    );

    expect(container.querySelector(".onboarding-fda-note")).toBeNull();
  });

  // ----------------------------------------------------------------
  // FDA note - shown on darwin with FDA categories active
  // ----------------------------------------------------------------
  it("shows FDA note on darwin when FDA-requiring categories are active", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = { platform: "darwin" };

    const states: Record<DiscoveryCategory, boolean> = {
      dev_environment: false,
      apps_system: true, // requiresFDA = true
      messages_notes: false,
    };

    const { container } = render(
      <OnboardingDiscovery
        categoryStates={states}
        onToggleCategory={vi.fn()}
      />,
    );

    const fdaNote = container.querySelector(".onboarding-fda-note");
    expect(fdaNote).not.toBeNull();
    expect(
      screen.getByText("Some options require Full Disk Access"),
    ).toBeInTheDocument();
    expect(screen.getByText("Open Preferences")).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // FDA note - not shown when no FDA categories are active
  // ----------------------------------------------------------------
  it("does not show FDA note on darwin when no FDA categories are active", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = { platform: "darwin" };

    const states: Record<DiscoveryCategory, boolean> = {
      dev_environment: true, // requiresFDA = false
      apps_system: false,
      messages_notes: false,
    };

    const { container } = render(
      <OnboardingDiscovery
        categoryStates={states}
        onToggleCategory={vi.fn()}
      />,
    );

    expect(container.querySelector(".onboarding-fda-note")).toBeNull();
  });

  // ----------------------------------------------------------------
  // Open Preferences button
  // ----------------------------------------------------------------
  it("calls openFullDiskAccess when 'Open Preferences' is clicked", () => {
    const mockOpenFDA = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      openFullDiskAccess: mockOpenFDA,
    };

    const states: Record<DiscoveryCategory, boolean> = {
      dev_environment: false,
      apps_system: true,
      messages_notes: false,
    };

    render(
      <OnboardingDiscovery
        categoryStates={states}
        onToggleCategory={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Open Preferences"));
    expect(mockOpenFDA).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // Fallback platform
  // ----------------------------------------------------------------
  it("uses 'unknown' platform when electronAPI is absent", () => {
    // When platform is "unknown" (not "darwin"), FDA note should not appear
    const states: Record<DiscoveryCategory, boolean> = {
      dev_environment: false,
      apps_system: true,
      messages_notes: false,
    };

    const { container } = render(
      <OnboardingDiscovery
        categoryStates={states}
        onToggleCategory={vi.fn()}
      />,
    );

    expect(container.querySelector(".onboarding-fda-note")).toBeNull();
  });
});
