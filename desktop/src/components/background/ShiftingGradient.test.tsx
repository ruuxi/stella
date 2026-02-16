import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ShiftingGradient } from "./ShiftingGradient";

// Mock the theme context
const mockThemeValues = {
  resolvedColorMode: "light" as "light" | "dark",
  themeId: "default",
  colors: {
    background: "#f8f7f7",
    backgroundWeak: "#f0f0f0",
    backgroundStrong: "#ffffff",
    foreground: "#1a1a1a",
    foregroundWeak: "#666666",
    foregroundStrong: "#000000",
    primary: "#6366f1",
    primaryForeground: "#ffffff",
    success: "#22c55e",
    warning: "#f59e0b",
    error: "#ef4444",
    info: "#3b82f6",
    interactive: "#8b5cf6",
    border: "#e5e5e5",
    borderWeak: "#f0f0f0",
    borderStrong: "#d4d4d4",
    card: "#ffffff",
    cardForeground: "#1a1a1a",
    muted: "#f5f5f5",
    mutedForeground: "#737373",
    accent: "#f5f5f5",
    accentForeground: "#1a1a1a",
  },
};

vi.mock("../../theme/theme-context", () => ({
  useTheme: () => mockThemeValues,
}));

// Mock generateGradientTokens to return predictable values
vi.mock("../../theme/color", () => ({
  generateGradientTokens: () => ({
    textInteractive: "#8b5cf6",
    surfaceInfoStrong: "#3b82f6",
    surfaceSuccessStrong: "#22c55e",
    surfaceWarningStrong: "#f59e0b",
    surfaceBrandBase: "#6366f1",
  }),
}));

// Mock cn utility
vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("ShiftingGradient", () => {
  let rafCallbacks: FrameRequestCallback[] = [];
  let originalRaf: typeof requestAnimationFrame;
  let originalCraf: typeof cancelAnimationFrame;

  beforeEach(() => {
    rafCallbacks = [];
    originalRaf = globalThis.requestAnimationFrame;
    originalCraf = globalThis.cancelAnimationFrame;

    // Mock requestAnimationFrame to capture callbacks
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    globalThis.cancelAnimationFrame = vi.fn();

    // Mock canvas 2D context for parseColor
    const mockCtx = {
      fillStyle: "",
      fillRect: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray([120, 130, 140, 255]),
      }),
    };
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        if (tagName === "canvas") {
          return {
            width: 0,
            height: 0,
            getContext: () => mockCtx,
          } as unknown as HTMLCanvasElement;
        }
        return document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          tagName
        ) as HTMLElement;
      }
    );
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCraf;
    vi.restoreAllMocks();
  });

  function flushRaf() {
    const current = [...rafCallbacks];
    rafCallbacks = [];
    current.forEach((cb) => cb(performance.now()));
  }

  it("renders the gradient container with aria-hidden", () => {
    const { container } = render(<ShiftingGradient />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("applies shifting-gradient class", () => {
    const { container } = render(<ShiftingGradient />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("shifting-gradient");
  });

  it("applies custom className", () => {
    const { container } = render(
      <ShiftingGradient className="my-custom-class" />
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("my-custom-class");
  });

  it("renders gradient-base layer", () => {
    const { container } = render(<ShiftingGradient />);
    expect(container.querySelector(".gradient-base")).toBeTruthy();
  });

  it("gradient-base has background set to var(--background)", () => {
    const { container } = render(<ShiftingGradient />);
    const base = container.querySelector(".gradient-base") as HTMLElement;
    expect(base.style.background).toBe("var(--background)");
  });

  it("renders gradient blobs after rAF fires", () => {
    const { container } = render(<ShiftingGradient />);

    // No blobs initially
    expect(container.querySelectorAll(".gradient-blob").length).toBe(0);

    // Fire first rAF (triggers generateBlobs)
    act(() => {
      flushRaf();
    });

    // Should have 5 blobs (one per BASE_POSITIONS entry)
    expect(container.querySelectorAll(".gradient-blob").length).toBe(5);
  });

  it("blobs have size, position, and filter styles", () => {
    const { container } = render(<ShiftingGradient />);

    act(() => {
      flushRaf();
    });

    const blobs = container.querySelectorAll(
      ".gradient-blob"
    ) as NodeListOf<HTMLElement>;
    expect(blobs.length).toBe(5);

    for (const blob of blobs) {
      // Each blob should have width, height, left, top, transform, filter
      expect(blob.style.width).toMatch(/\d+px/);
      expect(blob.style.height).toMatch(/\d+px/);
      expect(blob.style.left).toMatch(/[\d.]+%/);
      expect(blob.style.top).toMatch(/[\d.]+%/);
      expect(blob.style.filter).toMatch(/blur\(\d+px\)/);
      expect(blob.style.borderRadius).toBe("9999px");
    }
  });

  it("blobs have radial-gradient background", () => {
    const { container } = render(<ShiftingGradient />);

    act(() => {
      flushRaf();
    });

    const blob = container.querySelector(
      ".gradient-blob"
    ) as HTMLElement;
    expect(blob.style.background).toContain("radial-gradient");
  });

  it("renders grain overlay", () => {
    const { container } = render(<ShiftingGradient />);
    expect(container.querySelector(".gradient-grain")).toBeTruthy();
  });

  it("grain opacity is 0.28 for soft mode", () => {
    const { container } = render(<ShiftingGradient mode="soft" />);
    const grain = container.querySelector(
      ".gradient-grain"
    ) as HTMLElement;
    expect(grain.style.opacity).toBe("0.28");
  });

  it("grain opacity is 0.55 for crisp mode", () => {
    const { container } = render(<ShiftingGradient mode="crisp" />);
    const grain = container.querySelector(
      ".gradient-grain"
    ) as HTMLElement;
    expect(grain.style.opacity).toBe("0.55");
  });

  it("transitions are set to none before ready", () => {
    const { container } = render(<ShiftingGradient />);

    // First rAF fires to generate blobs but ready is still false
    act(() => {
      flushRaf();
    });

    const blob = container.querySelector(
      ".gradient-blob"
    ) as HTMLElement;
    expect(blob.style.transition).toBe("none");
  });

  it("transitions are applied after second rAF (ready=true)", () => {
    const { container } = render(<ShiftingGradient />);

    // First rAF: generate blobs + schedule second rAF for ready
    act(() => {
      flushRaf();
    });

    // Second rAF: set ready = true
    act(() => {
      flushRaf();
    });

    const blob = container.querySelector(
      ".gradient-blob"
    ) as HTMLElement;
    expect(blob.style.transition).not.toBe("none");
    expect(blob.style.transition).toContain("left");
  });

  it("uses default prop values", () => {
    const { container } = render(<ShiftingGradient />);

    act(() => {
      flushRaf();
    });

    // Default mode is "soft", blobs should render
    expect(container.querySelectorAll(".gradient-blob").length).toBe(5);
  });

  it("renders with crisp mode", () => {
    const { container } = render(<ShiftingGradient mode="crisp" />);

    act(() => {
      flushRaf();
    });

    // Blobs should still render
    expect(container.querySelectorAll(".gradient-blob").length).toBe(5);
  });

  it("renders with strong colorMode", () => {
    const { container } = render(
      <ShiftingGradient colorMode="strong" />
    );

    act(() => {
      flushRaf();
    });

    expect(container.querySelectorAll(".gradient-blob").length).toBe(5);
  });

  it("renders backdrop blur layer", () => {
    const { container } = render(<ShiftingGradient />);
    // Find the element with backdropFilter style
    const allDivs = container.querySelectorAll("div");
    const blurLayer = Array.from(allDivs).find(
      (div) =>
        (div as HTMLElement).style.backdropFilter === "blur(60px)"
    );
    expect(blurLayer).toBeTruthy();
  });

  it("renders color-mix overlay when background color is available", () => {
    const { container } = render(<ShiftingGradient />);
    const allDivs = container.querySelectorAll("div");
    const overlay = Array.from(allDivs).find((div) =>
      (div as HTMLElement).style.backgroundColor?.includes("color-mix")
    );
    expect(overlay).toBeTruthy();
  });

  it("cancels rAF on unmount", () => {
    const { unmount } = render(<ShiftingGradient />);
    unmount();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });

  it("regenerates blobs when themeId changes", () => {
    const { container, rerender } = render(<ShiftingGradient />);

    act(() => {
      flushRaf();
    });

    const blobsBefore = container.querySelectorAll(".gradient-blob");
    expect(blobsBefore.length).toBe(5);

    // Change themeId
    mockThemeValues.themeId = "new-theme";
    rerender(<ShiftingGradient />);

    act(() => {
      flushRaf();
    });

    const blobsAfter = container.querySelectorAll(".gradient-blob");
    expect(blobsAfter.length).toBe(5);

    // Reset
    mockThemeValues.themeId = "default";
  });

  it("handles dark mode", () => {
    mockThemeValues.resolvedColorMode = "dark";

    const { container } = render(<ShiftingGradient />);

    act(() => {
      flushRaf();
    });

    expect(container.querySelectorAll(".gradient-blob").length).toBe(5);

    // Reset
    mockThemeValues.resolvedColorMode = "light";
  });
});
