import { describe, expect, it } from "vitest";

import { createMapTool } from "../../../../../runtime/kernel/tools/defs/map.js";
import {
  appleMapsUrl,
  isMapRouteArtifact,
  mapsEmbedUrl,
  type MapRouteArtifact,
} from "../../../../../runtime/contracts/map-artifact.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const context: ToolContext = {
  conversationId: "c1",
  deviceId: "d1",
  requestId: "r1",
};

const routeArtifact: MapRouteArtifact = {
  kind: "map-route",
  version: 1,
  markers: [
    { id: "origin", name: "Ferry Building", lat: 37.7952, lng: -122.3938, role: "origin" },
    { id: "destination", name: "Golden Gate Bridge", lat: 37.8075, lng: -122.4756, role: "destination" },
  ],
  route: {
    mode: "driving",
    originId: "origin",
    destinationId: "destination",
    distanceMeters: 8653,
    durationSeconds: 1164,
    summary: "US-101",
    polyline: "abc123",
    steps: [{ instruction: "Head northwest", distanceMeters: 1649 }],
  },
};

const placesArtifact: MapRouteArtifact = {
  kind: "map-route",
  version: 1,
  markers: [
    {
      id: "p1",
      name: "Blue Bottle Coffee",
      lat: 37.7961,
      lng: -122.3939,
      address: "1 Ferry Building #7",
      rating: 4.3,
      ratingCount: 909,
      role: "place",
    },
  ],
};

const fetchReturning = (
  status: number,
  body: unknown,
): { impl: typeof fetch; calls: Array<{ url: string; body: unknown }> } => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
};

describe("map tool", () => {
  it("emits the map-route artifact and a route summary", async () => {
    const { impl, calls } = fetchReturning(200, {
      map: routeArtifact,
      unresolved: [],
    });
    const tool = createMapTool({ fetchImpl: impl, siteBaseUrl: "https://example.test" });
    const result = await tool.execute(
      {
        origin: "Ferry Building",
        destination: "Golden Gate Bridge",
        mode: "driving",
      },
      context,
    );
    expect(result.error).toBeUndefined();
    expect((result.details as { map: unknown }).map).toEqual(routeArtifact);
    expect(String(result.result)).toContain("driving route");
    expect(String(result.result)).toContain("19 min");
    expect(String(result.result)).toContain("8.7 km");
    expect(calls[0]?.url).toBe("https://example.test/api/maps/resolve");
    expect(calls[0]?.body).toEqual({
      origin: "Ferry Building",
      destination: "Golden Gate Bridge",
      mode: "driving",
    });
  });

  it("summarizes pinned places with ratings and reports misses", async () => {
    const { impl } = fetchReturning(200, {
      map: placesArtifact,
      unresolved: ["Nonexistent Cafe"],
    });
    const tool = createMapTool({ fetchImpl: impl });
    const result = await tool.execute(
      { places: ["Blue Bottle Coffee", "Nonexistent Cafe"] },
      context,
    );
    expect(result.error).toBeUndefined();
    expect(String(result.result)).toContain("Blue Bottle Coffee");
    expect(String(result.result)).toContain("4.3★");
    expect(String(result.result)).toContain("Could not find: Nonexistent Cafe");
  });

  it("returns a clear error instead of a broken card when the service fails", async () => {
    const { impl } = fetchReturning(422, { error: "No driving route found." });
    const tool = createMapTool({ fetchImpl: impl });
    const result = await tool.execute(
      { origin: "A", destination: "B" },
      context,
    );
    expect(result.details).toBeUndefined();
    expect(result.error).toBe("Map lookup failed: No driving route found.");
  });

  it("rejects malformed service payloads", async () => {
    const { impl } = fetchReturning(200, { map: { kind: "map-route", markers: [] } });
    const tool = createMapTool({ fetchImpl: impl });
    const result = await tool.execute({ places: ["x"] }, context);
    expect(result.error).toContain("no usable map");
  });

  it("validates inputs before calling the service", async () => {
    const { impl, calls } = fetchReturning(200, {});
    const tool = createMapTool({ fetchImpl: impl });
    expect((await tool.execute({}, context)).error).toContain("Provide places");
    expect((await tool.execute({ origin: "A" }, context)).error).toContain(
      "both origin and destination",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("map-route artifact helpers", () => {
  it("guards artifact shape", () => {
    expect(isMapRouteArtifact(routeArtifact)).toBe(true);
    expect(isMapRouteArtifact(placesArtifact)).toBe(true);
    expect(isMapRouteArtifact({ kind: "map-route", markers: [] })).toBe(false);
    expect(
      isMapRouteArtifact({ ...routeArtifact, route: { polyline: "" } }),
    ).toBe(false);
    expect(isMapRouteArtifact(null)).toBe(false);
  });

  it("builds an embed url carrying the slimmed payload and theme mode", () => {
    const url = new URL(mapsEmbedUrl(routeArtifact, { mode: "dark" }));
    expect(url.origin).toBe("https://stella.sh");
    expect(url.pathname).toBe("/maps/embed");
    expect(url.searchParams.get("mode")).toBe("dark");
    expect(url.searchParams.get("embedded")).toBe("1");
    const encoded = url.searchParams.get("d")!;
    const decoded = JSON.parse(
      Buffer.from(
        encoded.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as MapRouteArtifact;
    expect(decoded.route?.polyline).toBe("abc123");
    // Steps are stripped from the embed payload (URL budget).
    expect(decoded.route?.steps).toBeUndefined();
    expect(decoded.markers).toHaveLength(2);
  });

  it("builds Apple Maps handoff links for routes and pins", () => {
    const route = new URL(appleMapsUrl(routeArtifact));
    expect(route.searchParams.get("saddr")).toBe("37.7952,-122.3938");
    expect(route.searchParams.get("daddr")).toBe("37.8075,-122.4756");
    expect(route.searchParams.get("dirflg")).toBe("d");
    const pin = new URL(appleMapsUrl(placesArtifact));
    expect(pin.searchParams.get("q")).toBe("Blue Bottle Coffee");
    expect(pin.searchParams.get("ll")).toBe("37.7961,-122.3939");
  });
});
