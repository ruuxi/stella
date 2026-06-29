import { describe, expect, it } from "vitest";
import { getToolResultPreview } from "../../../../runtime/kernel/agent-runtime/shared.js";
import { pickScheduleToolSummary } from "@/global/schedule/schedule-receipt-summary";

describe("getToolResultPreview", () => {
  it("prefers human-readable Schedule tool result over structured details", () => {
    const preview = getToolResultPreview("Schedule", {
      result:
        "Created morning and evening check-in schedules for discipline rebuild.",
      details: {
        schedule: {
          affected: [
            {
              kind: "cron",
              id: "cron:abc",
              conversationId: "conv-1",
              name: "Morning Anchor",
              enabled: true,
              nextRunAtMs: 1,
            },
          ],
        },
      },
    });

    expect(preview).toBe(
      "Created morning and evening check-in schedules for discipline rebuild.",
    );
    expect(preview).not.toContain('"schedule"');
  });
});

describe("pickScheduleToolSummary", () => {
  it("drops persisted schedule side-channel JSON from dialog summaries", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview:
          '{ "schedule": { "affected": [ { "kind": "cron", "id": "cron:abc", "name": "Morning Anchor" } ] } }',
      }),
    ).toBeUndefined();
  });

  it("keeps plain-language schedule summaries", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview: "Set up daily morning and evening check-ins.",
      }),
    ).toBe("Set up daily morning and evening check-ins.");
  });
});
