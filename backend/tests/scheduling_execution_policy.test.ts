import { describe, test, expect } from "bun:test";
import { buildDesktopTurnCandidates } from "../convex/scheduling/desktop_handoff_policy";

describe("buildDesktopTurnCandidates", () => {
  test("returns desktop then backend when targetDeviceId provided", () => {
    const candidates = buildDesktopTurnCandidates({ targetDeviceId: "device-123" });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({ mode: "desktop", targetDeviceId: "device-123" });
    expect(candidates[1]).toEqual({ mode: "backend" });
  });

  test("returns only backend when no targetDeviceId", () => {
    const candidates = buildDesktopTurnCandidates({});
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({ mode: "backend" });
  });

  test("returns only backend when targetDeviceId is null", () => {
    const candidates = buildDesktopTurnCandidates({ targetDeviceId: null });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({ mode: "backend" });
  });

  test("returns only backend when targetDeviceId is undefined", () => {
    const candidates = buildDesktopTurnCandidates({ targetDeviceId: undefined });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({ mode: "backend" });
  });
});
