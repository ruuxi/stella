import { describe, test, expect } from "bun:test";
import { buildExecutionCandidates } from "../convex/scheduling/execution_policy";

describe("buildExecutionCandidates", () => {
  test("returns local then cloud when targetDeviceId provided", () => {
    const candidates = buildExecutionCandidates({ targetDeviceId: "device-123" });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({ mode: "local", targetDeviceId: "device-123" });
    expect(candidates[1]).toEqual({ mode: "cloud" });
  });

  test("returns only cloud when no targetDeviceId", () => {
    const candidates = buildExecutionCandidates({});
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({ mode: "cloud" });
  });

  test("returns only cloud when targetDeviceId is null", () => {
    const candidates = buildExecutionCandidates({ targetDeviceId: null });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({ mode: "cloud" });
  });

  test("returns only cloud when targetDeviceId is undefined", () => {
    const candidates = buildExecutionCandidates({ targetDeviceId: undefined });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({ mode: "cloud" });
  });
});
