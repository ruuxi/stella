import { describe, expect, it } from "vitest";
import { pageMobileAgentReplayEvents } from "../../electron/ipc/agent-handlers.js";

describe("mobile agent replay paging", () => {
  it("keeps legacy callers on the complete replay window", () => {
    const result = pageMobileAgentReplayEvents([1, 2, 3]);
    expect(result).toEqual({ events: [1, 2, 3], hasMore: false });
  });

  it("bounds new-peer pages and advertises continuation", () => {
    const events = Array.from({ length: 501 }, (_, index) => index + 1);
    const first = pageMobileAgentReplayEvents(events, 200);
    expect(first.events).toHaveLength(200);
    expect(first.events[0]).toBe(1);
    expect(first.events.at(-1)).toBe(200);
    expect(first.hasMore).toBe(true);

    const final = pageMobileAgentReplayEvents(events.slice(400), 200);
    expect(final.events).toHaveLength(101);
    expect(final.hasMore).toBe(false);
  });

  it("caps untrusted page sizes", () => {
    const result = pageMobileAgentReplayEvents(
      Array.from({ length: 400 }, (_, index) => index),
      10_000,
    );
    expect(result.events).toHaveLength(250);
    expect(result.hasMore).toBe(true);
  });
});
