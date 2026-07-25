import { describe, expect, it } from "vitest";
import {
  countingDownUserApps,
  liveUserAppInputSlug,
  MAX_RETAINED_USER_APPS,
  mountedUserApps,
  promoteRetainedUserApp,
} from "@/app/apps/user-app-keep-alive";

describe("user app retention", () => {
  it("moves a returning app back to the front without duplicating it", () => {
    expect(promoteRetainedUserApp(["b", "a"], "a")).toEqual(["a", "b"]);
  });

  it("leaves the list alone when the app is already in front", () => {
    const retained = ["a", "b"];
    expect(promoteRetainedUserApp(retained, "a")).toBe(retained);
  });

  it("evicts the least recently used app past the retention cap", () => {
    expect(MAX_RETAINED_USER_APPS).toBe(3);
    expect(promoteRetainedUserApp(["c", "b", "a"], "d")).toEqual([
      "d",
      "c",
      "b",
    ]);
  });
});

describe("user app teardown", () => {
  it("never counts down the app the user is inside", () => {
    expect(countingDownUserApps(["a", "b", "c"], "a")).toEqual(["b", "c"]);
  });

  it("counts every retained app down once the section is back on its list", () => {
    expect(countingDownUserApps(["a", "b"], null)).toEqual(["a", "b"]);
  });
});

describe("mounted user apps", () => {
  it("renders the active app before retention state has caught up", () => {
    expect(mountedUserApps([], "a")).toEqual(["a"]);
  });

  it("keeps the retention cap while doing so", () => {
    expect(mountedUserApps(["c", "b", "a"], "d")).toEqual(["d", "c", "b"]);
  });

  it("keeps hidden apps mounted when no app is open", () => {
    expect(mountedUserApps(["a", "b"], null)).toEqual(["a", "b"]);
  });
});

describe("user app input liveness", () => {
  it("lets the open app receive input while its section is showing", () => {
    expect(
      liveUserAppInputSlug({
        activeSlug: "a",
        activeSection: "apps",
        panelOpen: true,
      }),
    ).toBe("a");
  });

  // The panel closing does not change the section's remembered location, so
  // an app left live here would keep its window keydown binding and swallow
  // what the user types into chat.
  it("silences the open app when the panel closes", () => {
    expect(
      liveUserAppInputSlug({
        activeSlug: "a",
        activeSection: "apps",
        panelOpen: false,
      }),
    ).toBeNull();
  });

  it("silences the open app when another section is showing", () => {
    expect(
      liveUserAppInputSlug({
        activeSlug: "a",
        activeSection: "files",
        panelOpen: true,
      }),
    ).toBeNull();
  });

  it("has nothing to keep live on the library list", () => {
    expect(
      liveUserAppInputSlug({
        activeSlug: null,
        activeSection: "apps",
        panelOpen: true,
      }),
    ).toBeNull();
  });
});
