import { describe, expect, it } from "vitest";
import {
  hasEnoughOpenPanelReportActivity,
  latestOpenPanelReportSlotAt,
  type OpenPanelReportCadence,
} from "../../../runtime/kernel/agent-runtime/open-panel-cadence-reports";
import type { LocalChatRecentActivityRecord } from "../../../runtime/kernel/storage/shared";

const localMs = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
) => new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

const latestSlot = (cadence: OpenPanelReportCadence, nowMs: number) =>
  latestOpenPanelReportSlotAt(cadence, nowMs);

const userEvent = (
  id: string,
  payload: Record<string, unknown> = { text: "hello" },
): LocalChatRecentActivityRecord => ({
  _id: id,
  conversationId: "conversation",
  timestamp: Date.now(),
  type: "user_message",
  payload,
});

const userEvents = (count: number): LocalChatRecentActivityRecord[] =>
  Array.from({ length: count }, (_, index) => userEvent(String(index)));

describe("open panel cadence report slots", () => {
  it("anchors 4h reports to active local slots", () => {
    expect(latestSlot("4h", localMs(2026, 5, 30, 7, 59))).toBe(
      localMs(2026, 5, 29, 20),
    );
    expect(latestSlot("4h", localMs(2026, 5, 30, 8))).toBe(
      localMs(2026, 5, 30, 8),
    );
    expect(latestSlot("4h", localMs(2026, 5, 30, 15, 30))).toBe(
      localMs(2026, 5, 30, 12),
    );
    expect(latestSlot("4h", localMs(2026, 5, 30, 23, 30))).toBe(
      localMs(2026, 5, 30, 20),
    );
  });

  it("anchors daily reports to 8am local time", () => {
    expect(latestSlot("daily", localMs(2026, 5, 30, 7, 59))).toBe(
      localMs(2026, 5, 29, 8),
    );
    expect(latestSlot("daily", localMs(2026, 5, 30, 8))).toBe(
      localMs(2026, 5, 30, 8),
    );
    expect(latestSlot("daily", localMs(2026, 5, 30, 23))).toBe(
      localMs(2026, 5, 30, 8),
    );
  });

  it("anchors weekly reports to Monday at 8am local time", () => {
    expect(latestSlot("weekly", localMs(2026, 5, 31, 12))).toBe(
      localMs(2026, 5, 25, 8),
    );
    expect(latestSlot("weekly", localMs(2026, 6, 1, 7, 59))).toBe(
      localMs(2026, 5, 25, 8),
    );
    expect(latestSlot("weekly", localMs(2026, 6, 1, 8))).toBe(
      localMs(2026, 6, 1, 8),
    );
  });
});

describe("open panel cadence report activity gate", () => {
  it("requires visible Stella activity by cadence", () => {
    expect(hasEnoughOpenPanelReportActivity("4h", userEvents(19))).toBe(false);
    expect(hasEnoughOpenPanelReportActivity("4h", userEvents(20))).toBe(true);
    expect(hasEnoughOpenPanelReportActivity("daily", userEvents(39))).toBe(
      false,
    );
    expect(hasEnoughOpenPanelReportActivity("daily", userEvents(40))).toBe(
      true,
    );
    expect(hasEnoughOpenPanelReportActivity("weekly", userEvents(59))).toBe(
      false,
    );
    expect(hasEnoughOpenPanelReportActivity("weekly", userEvents(60))).toBe(
      true,
    );
  });

  it("does not count hidden synthetic user messages as activity", () => {
    const hidden = userEvent("hidden", {
      text: "hidden",
      metadata: { ui: { visibility: "hidden" } },
    });

    expect(hasEnoughOpenPanelReportActivity("4h", [hidden])).toBe(false);
  });
});
