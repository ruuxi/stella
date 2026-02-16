import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OnboardingMockWindows } from "./OnboardingMockWindows";

describe("OnboardingMockWindows", () => {
  // ----------------------------------------------------------------
  // Null activeWindowId
  // ----------------------------------------------------------------
  it("renders empty container when activeWindowId is null", () => {
    const { container } = render(
      <OnboardingMockWindows activeWindowId={null} />,
    );

    const wrapper = container.querySelector(".onboarding-mock-windows");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.children.length).toBe(0);
  });

  // ----------------------------------------------------------------
  // Browser window
  // ----------------------------------------------------------------
  it("renders Browser History window for 'browser' id", () => {
    render(
      <OnboardingMockWindows activeWindowId="browser" />,
    );

    expect(screen.getByText("Browser History")).toBeInTheDocument();

    // Check mock browser data is present
    expect(screen.getByText("Most Visited (7d)")).toBeInTheDocument();
    expect(screen.getByText("youtube.com")).toBeInTheDocument();
    expect(screen.getByText("112 visits")).toBeInTheDocument();
    expect(screen.getByText("Bookmarks")).toBeInTheDocument();
    expect(screen.getByText("Netflix")).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // Apps & System window
  // ----------------------------------------------------------------
  it("renders Apps & System window for 'apps_system' id", () => {
    render(<OnboardingMockWindows activeWindowId="apps_system" />);

    expect(screen.getByText("Apps & System")).toBeInTheDocument();

    // Check mock app data
    expect(screen.getByText("Running")).toBeInTheDocument();
    // "Spotify" appears in both Running and Screen Time sections
    expect(screen.getAllByText("Spotify")).toHaveLength(2);
    // "Active" appears for all running apps
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getByText("Screen Time (7d)")).toBeInTheDocument();
    expect(screen.getByText("Instagram")).toBeInTheDocument();
    expect(screen.getByText("4h 12m")).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // Notes & Calendar window
  // ----------------------------------------------------------------
  it("renders Notes & Calendar window for 'messages_notes' id", () => {
    render(<OnboardingMockWindows activeWindowId="messages_notes" />);

    expect(screen.getByText("Notes & Calendar")).toBeInTheDocument();

    // Check mock notes data
    expect(screen.getByText("Notes")).toBeInTheDocument();
    // "Personal" appears in both Notes (34 notes) and Calendar (24 events) sections
    expect(screen.getAllByText("Personal")).toHaveLength(2);
    expect(screen.getByText("34 notes")).toBeInTheDocument();
    expect(screen.getByText("Calendar")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("156 events")).toBeInTheDocument();
    expect(screen.getByText("Recurring")).toBeInTheDocument();
    expect(screen.getByText("Gym")).toBeInTheDocument();
    expect(screen.getByText("3x/week")).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // Coding Setup window
  // ----------------------------------------------------------------
  it("renders Coding Setup window for 'dev_environment' id", () => {
    render(<OnboardingMockWindows activeWindowId="dev_environment" />);

    expect(screen.getByText("Coding Setup")).toBeInTheDocument();

    // Check mock dev data (uses SimpleList with tags)
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("stella")).toBeInTheDocument();
    expect(screen.getByText("my-portfolio")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("git")).toBeInTheDocument();
    expect(screen.getByText("bun")).toBeInTheDocument();
    expect(screen.getByText("docker")).toBeInTheDocument();
    expect(screen.getByText("Dotfiles")).toBeInTheDocument();
    expect(screen.getByText(".zshrc")).toBeInTheDocument();
    expect(screen.getByText("Runtimes")).toBeInTheDocument();
    expect(screen.getByText("nvm")).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // Invalid window id
  // ----------------------------------------------------------------
  it("renders empty container for an unknown window id", () => {
    const { container } = render(
      <OnboardingMockWindows activeWindowId="nonexistent" />,
    );

    const wrapper = container.querySelector(".onboarding-mock-windows");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.children.length).toBe(0);
  });

  // ----------------------------------------------------------------
  // MockWindow structure
  // ----------------------------------------------------------------
  it("renders mock window with titlebar dots and title", () => {
    const { container } = render(
      <OnboardingMockWindows activeWindowId="browser" />,
    );

    // Check titlebar structure
    const titlebar = container.querySelector(
      ".onboarding-mock-window-titlebar",
    );
    expect(titlebar).not.toBeNull();

    const dots = container.querySelector(".onboarding-mock-window-dots");
    expect(dots).not.toBeNull();
    // 3 dot spans
    expect(dots!.querySelectorAll("span").length).toBe(3);

    const title = container.querySelector(".onboarding-mock-window-title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Browser History");
  });

  // ----------------------------------------------------------------
  // Window body
  // ----------------------------------------------------------------
  it("renders mock window body with content", () => {
    const { container } = render(
      <OnboardingMockWindows activeWindowId="browser" />,
    );

    const body = container.querySelector(".onboarding-mock-window-body");
    expect(body).not.toBeNull();
    expect(body!.children.length).toBeGreaterThan(0);
  });

  // ----------------------------------------------------------------
  // Switching windows
  // ----------------------------------------------------------------
  it("switches content when activeWindowId changes", () => {
    const { rerender } = render(
      <OnboardingMockWindows activeWindowId="browser" />,
    );

    expect(screen.getByText("Browser History")).toBeInTheDocument();

    rerender(<OnboardingMockWindows activeWindowId="dev_environment" />);

    expect(screen.getByText("Coding Setup")).toBeInTheDocument();
    expect(screen.queryByText("Browser History")).not.toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // DetailList rendering for browser sections
  // ----------------------------------------------------------------
  it("renders detail rows with name and value", () => {
    const { container } = render(
      <OnboardingMockWindows activeWindowId="browser" />,
    );

    const detailRows = container.querySelectorAll(".mock-window-detail-row");
    expect(detailRows.length).toBeGreaterThan(0);

    // Check first detail row has name and value
    const firstRow = detailRows[0];
    const name = firstRow.querySelector(".mock-window-detail-name");
    const value = firstRow.querySelector(".mock-window-detail-value");
    expect(name).not.toBeNull();
    expect(value).not.toBeNull();
  });

  // ----------------------------------------------------------------
  // SimpleList rendering for dev sections
  // ----------------------------------------------------------------
  it("renders tag elements for dev_environment SimpleList", () => {
    const { container } = render(
      <OnboardingMockWindows activeWindowId="dev_environment" />,
    );

    const tags = container.querySelectorAll(".mock-window-tag");
    // MOCK_DEV has 4 sections with 4+6+4+3 = 17 items
    expect(tags.length).toBe(17);
  });

  // ----------------------------------------------------------------
  // Section labels
  // ----------------------------------------------------------------
  it("renders section labels correctly", () => {
    const { container } = render(
      <OnboardingMockWindows activeWindowId="apps_system" />,
    );

    const labels = container.querySelectorAll(".mock-window-section-label");
    expect(labels.length).toBe(2); // "Running" and "Screen Time (7d)"
    expect(labels[0].textContent).toBe("Running");
    expect(labels[1].textContent).toBe("Screen Time (7d)");
  });
});
