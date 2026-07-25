import { describe, expect, it } from "vitest";
import {
  countingDownUserApps,
  onScreenUserAppSlug,
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
  it("never counts down the app the user is looking at", () => {
    expect(countingDownUserApps(["a", "b", "c"], "a")).toEqual(["b", "c"]);
  });

  it("counts every retained app down once the section is back on its list", () => {
    expect(countingDownUserApps(["a", "b"], null)).toEqual(["a", "b"]);
  });

  // The teardown clock keys off what is on screen, not off what the section
  // remembers. Closing the panel or switching to Files leaves `locations.apps`
  // pointing at the app — if that suppressed the clock, the app the user
  // opened last (usually the only one) could never time out, and a polling or
  // animating app would run untouched for the rest of the session.
  it("counts the remembered app down once it is off screen", () => {
    const onScreen = onScreenUserAppSlug({
      activeSlug: "a",
      activeSection: "apps",
      panelOpen: false,
    });
    expect(countingDownUserApps(["a", "b"], onScreen)).toEqual(["a", "b"]);
  });
});

describe("mounted user apps", () => {
  it("renders the on-screen app before retention state has caught up", () => {
    expect(mountedUserApps([], "a")).toEqual(["a"]);
  });

  it("keeps the retention cap while doing so", () => {
    expect(mountedUserApps(["c", "b", "a"], "d")).toEqual(["d", "c", "b"]);
  });

  it("keeps hidden apps mounted when no app is on screen", () => {
    expect(mountedUserApps(["a", "b"], null)).toEqual(["a", "b"]);
  });

  // A location restored from a previous session is non-null on the very first
  // render. Mounting off it would fetch the app's chunk and run its mount
  // effects during startup, for a surface the user may never open.
  it("does not mount a restored location before the section is shown", () => {
    const onScreen = onScreenUserAppSlug({
      activeSlug: "a",
      activeSection: "tasks",
      panelOpen: false,
    });
    expect(mountedUserApps([], onScreen)).toEqual([]);
  });
});

describe("user app input liveness", () => {
  it("lets the open app receive input while its section is showing", () => {
    expect(
      onScreenUserAppSlug({
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
      onScreenUserAppSlug({
        activeSlug: "a",
        activeSection: "apps",
        panelOpen: false,
      }),
    ).toBeNull();
  });

  it("silences the open app when another section is showing", () => {
    expect(
      onScreenUserAppSlug({
        activeSlug: "a",
        activeSection: "files",
        panelOpen: true,
      }),
    ).toBeNull();
  });

  it("has nothing to keep live on the library list", () => {
    expect(
      onScreenUserAppSlug({
        activeSlug: null,
        activeSection: "apps",
        panelOpen: true,
      }),
    ).toBeNull();
  });
});
