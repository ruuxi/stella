import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// ---------- Mocks ----------

// Mock getElectronApi to return undefined (no API)
vi.mock("../services/electron", () => ({
  getElectronApi: () => undefined,
}));

// Mock useTheme to return fake colors
vi.mock("../theme/theme-context", () => ({
  useTheme: () => ({
    colors: {
      interactive: "#ff0000",
      card: "#111111",
      border: "#333333",
      primaryForeground: "#ffffff",
      mutedForeground: "#888888",
      background: "#000000",
    },
  }),
}));

// Mock StellaAnimation as a simple div
vi.mock("../components/StellaAnimation", () => ({
  StellaAnimation: () => <div data-testid="stella-animation" />,
}));

// We need to test helper functions directly, so we import the module
// and also mock hexToRgb at the color module level
vi.mock("../theme/color", () => ({
  hexToRgb: (hex: string) => {
    // Simple implementation for testing
    const h = hex.replace("#", "");
    const num = parseInt(h, 16);
    return {
      r: ((num >> 16) & 255) / 255,
      g: ((num >> 8) & 255) / 255,
      b: (num & 255) / 255,
    };
  },
  generateGradientTokens: vi.fn(),
}));

import { RadialDial } from "./RadialDial";

// ---------- Tests ----------

describe("RadialDial", () => {
  // ---- Basic rendering ----

  it("renders the container with the correct class", () => {
    const { container } = render(<RadialDial />);
    expect(
      container.querySelector(".radial-dial-container"),
    ).toBeTruthy();
  });

  it("renders an SVG element with correct class", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial");
    expect(svg).toBeTruthy();
  });

  it("renders SVG with correct size attributes (280x280)", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial")!;
    expect(svg.getAttribute("width")).toBe("280");
    expect(svg.getAttribute("height")).toBe("280");
  });

  it("renders SVG with correct viewBox", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 280 280");
  });

  it("renders a center circle", () => {
    const { container } = render(<RadialDial />);
    const circle = container.querySelector("circle");
    expect(circle).toBeTruthy();
  });

  it("renders center circle at CENTER coordinates (140, 140)", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial")!;
    const circle = svg.querySelector(":scope > circle")!;
    expect(circle.getAttribute("cx")).toBe("140");
    expect(circle.getAttribute("cy")).toBe("140");
  });

  it("renders center circle with radius of INNER_RADIUS - 5 = 35", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial")!;
    const circle = svg.querySelector(":scope > circle")!;
    expect(circle.getAttribute("r")).toBe("35");
  });

  // ---- Wedge labels ----

  it("renders all 5 wedge labels", () => {
    render(<RadialDial />);
    expect(screen.getByText("Capture")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(screen.getByText("Voice")).toBeInTheDocument();
    expect(screen.getByText("Auto")).toBeInTheDocument();
  });

  it("renders exactly 5 wedge paths", () => {
    const { container } = render(<RadialDial />);
    const wedgePaths = container.querySelectorAll("path.wedge-path");
    expect(wedgePaths).toHaveLength(5);
  });

  it("each wedge path has a valid d attribute", () => {
    const { container } = render(<RadialDial />);
    const wedgePaths = container.querySelectorAll("path.wedge-path");
    wedgePaths.forEach((path) => {
      const d = path.getAttribute("d");
      expect(d).toBeTruthy();
      // Should contain M, L, A, Z commands
      expect(d).toContain("M");
      expect(d).toContain("L");
      expect(d).toContain("A");
      expect(d).toContain("Z");
    });
  });

  it("each wedge path has a fill attribute", () => {
    const { container } = render(<RadialDial />);
    const wedgePaths = container.querySelectorAll("path.wedge-path");
    wedgePaths.forEach((path) => {
      expect(path.getAttribute("fill")).toBeTruthy();
    });
  });

  it("each wedge path has a stroke attribute", () => {
    const { container } = render(<RadialDial />);
    const wedgePaths = container.querySelectorAll("path.wedge-path");
    wedgePaths.forEach((path) => {
      expect(path.getAttribute("stroke")).toBeTruthy();
    });
  });

  it("each wedge path has stroke-width of 1.5", () => {
    const { container } = render(<RadialDial />);
    const wedgePaths = container.querySelectorAll("path.wedge-path");
    wedgePaths.forEach((path) => {
      expect(path.getAttribute("stroke-width")).toBe("1.5");
    });
  });

  // ---- StellaAnimation ----

  it("renders the StellaAnimation mock", () => {
    render(<RadialDial />);
    expect(screen.getByTestId("stella-animation")).toBeInTheDocument();
  });

  it("renders the center stella animation wrapper", () => {
    const { container } = render(<RadialDial />);
    expect(
      container.querySelector(".radial-center-stella-animation"),
    ).toBeTruthy();
  });

  // ---- Frame visibility ----

  it("renders with radial-dial-frame class (not visible initially)", () => {
    const { container } = render(<RadialDial />);
    const frame = container.querySelector(".radial-dial-frame");
    expect(frame).toBeTruthy();
    // Initially should NOT have the visible class
    expect(frame!.classList.contains("radial-dial-frame--visible")).toBe(false);
  });

  // ---- ForeignObject elements ----

  it("renders 5 foreignObject elements for wedge content", () => {
    const { container } = render(<RadialDial />);
    const foreignObjects = container.querySelectorAll("foreignObject");
    expect(foreignObjects).toHaveLength(5);
  });

  it("foreignObject elements have pointer-events:none style", () => {
    const { container } = render(<RadialDial />);
    const foreignObjects = container.querySelectorAll("foreignObject");
    foreignObjects.forEach((fo) => {
      expect(fo.getAttribute("style")).toContain("pointer-events: none");
    });
  });

  // ---- Wedge groups ----

  it("renders 5 g (group) elements for wedges", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial")!;
    // g elements directly under svg (one per wedge)
    const groups = svg.querySelectorAll(":scope > g");
    expect(groups).toHaveLength(5);
  });

  // ---- Default selection state ----

  it("default selectedWedge is 'dismiss' so no wedge has the interactive fill", () => {
    const { container } = render(<RadialDial />);
    const wedgePaths = container.querySelectorAll("path.wedge-path");
    // With selectedWedge='dismiss', all wedges should use the card color as fill
    // The mock card color is "#111111"
    wedgePaths.forEach((path) => {
      const fill = path.getAttribute("fill");
      // Should be the card color, not the interactive (rgba) color
      expect(fill).toBe("#111111");
    });
  });

  it("no wedge stroke uses interactive color when none is selected", () => {
    const { container } = render(<RadialDial />);
    const wedgePaths = container.querySelectorAll("path.wedge-path");
    wedgePaths.forEach((path) => {
      const stroke = path.getAttribute("stroke");
      // Should be using border color as rgba, not the interactive color directly
      expect(stroke).toContain("rgba");
      expect(stroke).not.toContain("255, 0, 0"); // not the #ff0000 interactive color
    });
  });
});

describe("RadialDial helper functions (via rendering)", () => {
  it("wedge paths contain arc segments with OUTER_RADIUS=125", () => {
    const { container } = render(<RadialDial />);
    const paths = container.querySelectorAll("path.wedge-path");
    paths.forEach((path) => {
      const d = path.getAttribute("d")!;
      // Arc commands should reference the outer radius 125
      expect(d).toContain("125");
    });
  });

  it("wedge paths contain arc segments with INNER_RADIUS=40", () => {
    const { container } = render(<RadialDial />);
    const paths = container.querySelectorAll("path.wedge-path");
    paths.forEach((path) => {
      const d = path.getAttribute("d")!;
      // Arc commands should reference the inner radius 40
      expect(d).toContain("40");
    });
  });

  it("foreignObject positions are within SVG bounds (0-280)", () => {
    const { container } = render(<RadialDial />);
    const foreignObjects = container.querySelectorAll("foreignObject");
    foreignObjects.forEach((fo) => {
      const x = parseFloat(fo.getAttribute("x")!);
      const y = parseFloat(fo.getAttribute("y")!);
      // Content position should be roughly between inner and outer radius from center
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(280);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(280);
    });
  });

  it("foreignObject elements have width=56 and height=40", () => {
    const { container } = render(<RadialDial />);
    const foreignObjects = container.querySelectorAll("foreignObject");
    foreignObjects.forEach((fo) => {
      expect(fo.getAttribute("width")).toBe("56");
      expect(fo.getAttribute("height")).toBe("40");
    });
  });

  it("center circle fill uses rgba of background color with 0.95 alpha", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial")!;
    const circle = svg.querySelector(":scope > circle")!;
    const fill = circle.getAttribute("fill")!;
    // Background is #000000 -> rgb(0, 0, 0)
    expect(fill).toBe("rgba(0, 0, 0, 0.95)");
  });

  it("center circle stroke uses rgba of border color with 0.5 alpha", () => {
    const { container } = render(<RadialDial />);
    const svg = container.querySelector("svg.radial-dial")!;
    const circle = svg.querySelector(":scope > circle")!;
    const stroke = circle.getAttribute("stroke")!;
    // Border is #333333 -> rgb(51, 51, 51)
    expect(stroke).toBe("rgba(51, 51, 51, 0.5)");
  });
});
