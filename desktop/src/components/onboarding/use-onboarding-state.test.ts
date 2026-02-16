import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useOnboardingState,
  CENTER_PHASES,
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
  DISCOVERY_CATEGORIES,
  BROWSERS,
} from "./use-onboarding-state";

const ONBOARDING_KEY = "stella-onboarding-complete";

beforeEach(() => {
  localStorage.removeItem(ONBOARDING_KEY);
});

describe("useOnboardingState", () => {
  it("starts incomplete when no localStorage value", () => {
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(false);
  });

  it("starts completed when localStorage has 'true'", () => {
    localStorage.setItem(ONBOARDING_KEY, "true");
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(true);
  });

  it("complete() sets completed to true and persists", () => {
    const { result } = renderHook(() => useOnboardingState());
    act(() => result.current.complete());
    expect(result.current.completed).toBe(true);
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe("true");
  });

  it("reset() sets completed to false and removes key", () => {
    localStorage.setItem(ONBOARDING_KEY, "true");
    const { result } = renderHook(() => useOnboardingState());
    expect(result.current.completed).toBe(true);
    act(() => result.current.reset());
    expect(result.current.completed).toBe(false);
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull();
  });
});

describe("phase constants", () => {
  it("CENTER_PHASES contains start, auth, intro", () => {
    expect(CENTER_PHASES.has("start")).toBe(true);
    expect(CENTER_PHASES.has("auth")).toBe(true);
    expect(CENTER_PHASES.has("intro")).toBe(true);
    expect(CENTER_PHASES.has("browser")).toBe(false);
  });

  it("SPLIT_PHASES contains browser through personality", () => {
    expect(SPLIT_PHASES.has("browser")).toBe(true);
    expect(SPLIT_PHASES.has("memory")).toBe(true);
    expect(SPLIT_PHASES.has("creation")).toBe(true);
    expect(SPLIT_PHASES.has("theme")).toBe(true);
    expect(SPLIT_PHASES.has("personality")).toBe(true);
    expect(SPLIT_PHASES.has("start")).toBe(false);
  });

  it("SPLIT_STEP_ORDER has correct order", () => {
    expect(SPLIT_STEP_ORDER).toEqual([
      "browser",
      "memory",
      "creation",
      "theme",
      "personality",
    ]);
  });
});

describe("DISCOVERY_CATEGORIES", () => {
  it("has 3 categories", () => {
    expect(DISCOVERY_CATEGORIES).toHaveLength(3);
  });

  it("each has required fields", () => {
    for (const cat of DISCOVERY_CATEGORIES) {
      expect(cat.id).toBeTruthy();
      expect(cat.label).toBeTruthy();
      expect(cat.description).toBeTruthy();
      expect(typeof cat.defaultEnabled).toBe("boolean");
      expect(typeof cat.requiresFDA).toBe("boolean");
    }
  });
});

describe("BROWSERS", () => {
  it("includes common browsers", () => {
    const ids = BROWSERS.map((b) => b.id);
    expect(ids).toContain("chrome");
    expect(ids).toContain("firefox");
    expect(ids).toContain("edge");
    expect(ids).toContain("safari");
  });

  it("each has id and label", () => {
    for (const browser of BROWSERS) {
      expect(browser.id).toBeTruthy();
      expect(browser.label).toBeTruthy();
    }
  });
});
