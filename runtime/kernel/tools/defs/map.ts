/**
 * `map` tool — show the user an interactive map inline in the chat: pinned
 * places and/or a route with directions.
 *
 * The tool takes natural inputs (place names, addresses, "lat,lng" strings)
 * and POSTs them to the stella.sh maps resolve endpoint, which geocodes and
 * routes through Google APIs with a server-side key (zero keys and zero
 * setup on the user's machine — a hard product requirement). The resolved
 * `map-route` artifact lands on the tool_result `details`, where the desktop
 * chat card and the mobile bridge pick it up; the model gets a compact text
 * summary (distance, duration, top places) to speak from.
 *
 * Best-effort by design: resolution failures come back as a clear tool error
 * (the model can answer without a card), never a broken card.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import {
  isMapRouteArtifact,
  MAPS_RESOLVE_PATH,
  MAPS_SITE_BASE_URL,
  MAPS_SITE_URL_ENV,
  type MapRouteArtifact,
} from "../../../contracts/map-artifact.js";
import type { ToolDefinition } from "../types.js";

export type MapToolOptions = {
  /** Override the stella.sh base (tests, self-hosted resolve). */
  siteBaseUrl?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

const RESOLVE_TIMEOUT_MS = 25_000;
const MAX_PLACES = 8;

const MAP_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  description:
    "Show an interactive map card inline in the chat. Provide places to pin and/or origin+destination for a route.",
  properties: {
    places: {
      type: "array",
      items: { type: "string" },
      description:
        "Up to 8 places to pin, as natural queries — place names, addresses, or 'lat,lng' (e.g. 'Tartine Bakery San Francisco', '1 Ferry Building, SF'). Include the city/area when it isn't obvious from context.",
    },
    origin: {
      type: "string",
      description:
        "Route start, as a natural query. Requires destination. Combine with places to also pin stops along the way.",
    },
    destination: {
      type: "string",
      description: "Route end, as a natural query. Requires origin.",
    },
    mode: {
      type: "string",
      enum: ["driving", "walking", "cycling", "transit"],
      description: "Travel mode for the route. Defaults to driving.",
    },
    title: {
      type: "string",
      description:
        "Optional short card title (e.g. 'Coffee near the Ferry Building').",
    },
  },
};

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const formatDistance = (meters: number): string => {
  if (!Number.isFinite(meters) || meters <= 0) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  const miles = meters / 1609.344;
  return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km (${
    miles >= 100 ? Math.round(miles) : miles.toFixed(1)
  } mi)`;
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} hr ${rest} min` : `${hours} hr`;
};

/** Compact text the model can speak from; the card itself shows the map. */
const summarizeArtifact = (
  map: MapRouteArtifact,
  unresolved: string[],
): string => {
  const lines: string[] = [];
  if (map.route) {
    const origin = map.markers.find((m) => m.id === map.route?.originId);
    const destination = map.markers.find(
      (m) => m.id === map.route?.destinationId,
    );
    const distance = formatDistance(map.route.distanceMeters);
    const duration = formatDuration(map.route.durationSeconds);
    lines.push(
      `${map.route.mode} route from ${origin?.name ?? "origin"} to ${
        destination?.name ?? "destination"
      }: ${[distance, duration].filter(Boolean).join(", ")}${
        map.route.summary ? ` (${map.route.summary})` : ""
      }.`,
    );
    for (const step of (map.route.steps ?? []).slice(0, 10)) {
      lines.push(`  - ${step.instruction}`);
    }
  }
  const places = map.markers.filter((marker) => marker.role === "place");
  if (places.length > 0) {
    lines.push(`Pinned ${places.length === 1 ? "place" : "places"}:`);
    for (const place of places) {
      const rating =
        typeof place.rating === "number"
          ? ` — ${place.rating.toFixed(1)}★${
              typeof place.ratingCount === "number"
                ? ` (${place.ratingCount.toLocaleString()})`
                : ""
            }`
          : "";
      lines.push(
        `  - ${place.name}${rating}${place.address ? ` — ${place.address}` : ""}`,
      );
    }
  }
  if (unresolved.length > 0) {
    lines.push(`Could not find: ${unresolved.join("; ")}.`);
  }
  lines.push(
    "The interactive map card is now visible in the chat; don't re-describe the map itself.",
  );
  return lines.join("\n");
};

export const createMapTool = (options: MapToolOptions = {}): ToolDefinition => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveBase = () =>
    (
      options.siteBaseUrl ??
      process.env[MAPS_SITE_URL_ENV]?.trim() ??
      MAPS_SITE_BASE_URL
    ).replace(/\/+$/, "");

  return {
    name: "map",
    // Chat-surface artifact: only the orchestrator drops map cards into the
    // conversation, mirroring the html/canvas tool.
    agentTypes: [AGENT_IDS.ORCHESTRATOR],
    description:
      "Show the user an interactive map card inline in the chat — pinned places and/or a route with turn-by-turn-ready directions. Use when the user asks where something is, for places to go (restaurants, coffee, sights), or how to get somewhere. Provide natural inputs: `places` (up to 8 names/addresses) and/or `origin` + `destination` (+ `mode`). Resolution (geocoding, place ratings, route distance/duration) happens automatically; the result summary comes back for you to answer with, and the card includes an 'Open in Apple Maps' handoff. Don't use for abstract geography questions that need no map.",
    promptSnippet:
      "Show an inline interactive map (pins and/or a route) in the chat",
    workingText: "Mapping",
    parameters: MAP_TOOL_PARAMETERS,
    execute: async (args, _context, extras) => {
      const places = Array.isArray(args.places)
        ? args.places
            .map(asTrimmedString)
            .filter((entry) => entry.length > 0)
            .slice(0, MAX_PLACES)
        : [];
      const origin = asTrimmedString(args.origin);
      const destination = asTrimmedString(args.destination);
      const mode = asTrimmedString(args.mode).toLowerCase();
      const title = asTrimmedString(args.title);

      if ((origin && !destination) || (!origin && destination)) {
        return {
          error:
            "Provide both origin and destination for a route, or neither.",
        };
      }
      if (places.length === 0 && !origin) {
        return {
          error:
            "Provide places to pin and/or an origin + destination route.",
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
      const onAbort = () => controller.abort();
      extras?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetchImpl(
          `${resolveBase()}${MAPS_RESOLVE_PATH}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(places.length > 0 ? { places } : {}),
              ...(origin ? { origin, destination } : {}),
              ...(mode ? { mode } : {}),
              ...(title ? { title } : {}),
            }),
            signal: controller.signal,
          },
        );
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          // Non-JSON error body; fall through to the status message.
        }
        const record =
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : {};
        if (!response.ok) {
          const message =
            asTrimmedString(record.error) ||
            `map service returned ${response.status}`;
          return { error: `Map lookup failed: ${message}` };
        }
        const map = record.map;
        if (!isMapRouteArtifact(map)) {
          return {
            error: "Map lookup failed: the map service returned no usable map.",
          };
        }
        const unresolved = Array.isArray(record.unresolved)
          ? record.unresolved.map(asTrimmedString).filter(Boolean)
          : [];
        return {
          result: summarizeArtifact(map, unresolved),
          details: { map },
        };
      } catch (error) {
        const message =
          (error as Error).name === "AbortError"
            ? "timed out"
            : (error as Error).message;
        return { error: `Map lookup failed: ${message}` };
      } finally {
        clearTimeout(timer);
        extras?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
};
