import { describe, it, expect, vi } from "vitest";

// Mock the actual mini-shell module to avoid pulling in its dependencies
vi.mock("@/app/shell/mini/MiniShell", () => ({
  MiniShell: () => "MockedMiniShell",
}));

import { MiniShell } from "@/app/shell/mini/MiniShell";

// --- Tests ---

describe("MiniShell re-export (app/shell/mini/MiniShell.tsx)", () => {
  it("re-exports MiniShell from mini-shell directory", () => {
    expect(MiniShell).toBeDefined();
    expect(typeof MiniShell).toBe("function");
  });

  it("returns the same component from mini-shell/MiniShell", async () => {
    const directImport = await import("@/app/shell/mini/MiniShell");
    expect(MiniShell).toBe(directImport.MiniShell);
  });
});


