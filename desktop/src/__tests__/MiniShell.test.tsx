import { describe, it, expect, vi } from "vitest";

// Mock the actual mini-shell module to avoid pulling in its dependencies
vi.mock("../screens/mini-shell/MiniShell", () => ({
  MiniShell: () => "MockedMiniShell",
}));

import { MiniShell } from "../screens/MiniShell";

// --- Tests ---

describe("MiniShell re-export (screens/MiniShell.tsx)", () => {
  it("re-exports MiniShell from mini-shell directory", () => {
    expect(MiniShell).toBeDefined();
    expect(typeof MiniShell).toBe("function");
  });

  it("returns the same component from mini-shell/MiniShell", async () => {
    const directImport = await import("../screens/mini-shell/MiniShell");
    expect(MiniShell).toBe(directImport.MiniShell);
  });
});
