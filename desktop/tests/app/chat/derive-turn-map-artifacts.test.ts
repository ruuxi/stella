import { describe, expect, it } from "vitest";
import { deriveTurnMapArtifacts } from "@/features/chat/lib/derive-turn-map-artifacts";
import type { EventRecord } from "@/features/chat/lib/event-transforms";

const map = (name: string, polyline?: string) => ({
  kind: "map-route",
  version: 1,
  markers: [{ id: "p1", name, lat: 37.79, lng: -122.39 }],
  ...(polyline
    ? {
        route: {
          mode: "driving",
          originId: "p1",
          destinationId: "p1",
          distanceMeters: 100,
          durationSeconds: 60,
          polyline,
        },
      }
    : {}),
});

const result = (
  id: string,
  payload: Record<string, unknown>,
): EventRecord => ({
  _id: id,
  timestamp: 1_000,
  type: "tool_result",
  payload,
});

describe("deriveTurnMapArtifacts", () => {
  it("collects successful orchestrator map results in call order", () => {
    const cards = deriveTurnMapArtifacts([
      result("t1", { toolName: "map", map: map("First") }),
      result("t2", { toolName: "web", results: [] }),
      result("t3", { toolName: "map", map: map("Second", "poly") }),
    ]);
    expect(cards.map((card) => card.id)).toEqual(["t1", "t3"]);
    expect(cards[0]!.map.markers[0]!.name).toBe("First");
    expect(cards[1]!.map.route?.polyline).toBe("poly");
  });

  it("skips errored calls, subagent calls, and malformed payloads", () => {
    const cards = deriveTurnMapArtifacts([
      result("t1", { toolName: "map", error: "failed", map: map("X") }),
      result("t2", { toolName: "map", agentType: "general", map: map("Y") }),
      result("t3", { toolName: "map", map: { kind: "map-route", markers: [] } }),
      result("t4", { toolName: "map" }),
    ]);
    expect(cards).toEqual([]);
  });

  it("caps the number of cards per turn", () => {
    const events = Array.from({ length: 5 }, (_, index) =>
      result(`t${index}`, { toolName: "map", map: map(`Place ${index}`) }),
    );
    expect(deriveTurnMapArtifacts(events)).toHaveLength(3);
  });
});
