import { describe, expect, it } from "vitest";
import { getSelfModHmrFlushMode } from "../../vite.config.ts";

describe("getSelfModHmrFlushMode", () => {
  it("uses module reload when Vite has queued modules", () => {
    expect(
      getSelfModHmrFlushMode({
        queuedModuleCount: 2,
        queuedFileCount: 2,
        requiresFullReload: false,
      }),
    ).toBe("module-reload");
  });

  it("does not force full reload when files changed but Vite has no queued modules", () => {
    expect(
      getSelfModHmrFlushMode({
        queuedModuleCount: 0,
        queuedFileCount: 1,
        requiresFullReload: false,
      }),
    ).toBe("none");
  });

  it("returns none when nothing is queued", () => {
    expect(
      getSelfModHmrFlushMode({
        queuedModuleCount: 0,
        queuedFileCount: 0,
        requiresFullReload: false,
      }),
    ).toBe("none");
  });
});
