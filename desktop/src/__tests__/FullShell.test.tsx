import { describe, it, expect, vi } from "vitest";

// Mock the actual full-shell module to avoid pulling in its dependencies
vi.mock("../screens/full-shell/FullShell", () => ({
  FullShell: () => "MockedFullShell",
}));

import { FullShell } from "../screens/FullShell";

// --- Tests ---

describe("FullShell re-export (screens/FullShell.tsx)", () => {
  it("re-exports FullShell from full-shell directory", () => {
    expect(FullShell).toBeDefined();
    expect(typeof FullShell).toBe("function");
  });

  it("returns the same component from full-shell/FullShell", async () => {
    const directImport = await import("../screens/full-shell/FullShell");
    expect(FullShell).toBe(directImport.FullShell);
  });
});
