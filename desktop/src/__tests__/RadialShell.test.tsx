import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// --- Mocks ---

vi.mock("../screens/RadialDial", () => ({
  RadialDial: () => <div data-testid="radial-dial" />,
}));

import { RadialShell } from "../screens/RadialShell";

// --- Tests ---

describe("RadialShell", () => {
  it("renders a div with class radial-shell", () => {
    const { container } = render(<RadialShell />);
    expect(container.querySelector(".radial-shell")).toBeInTheDocument();
  });

  it("renders RadialDial inside the shell", () => {
    render(<RadialShell />);
    expect(screen.getByTestId("radial-dial")).toBeInTheDocument();
  });
});
