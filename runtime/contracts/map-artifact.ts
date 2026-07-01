/**
 * `map-route` artifact — the renderer-agnostic payload behind Stella's inline
 * chat map cards, plus the shared config for the services that power them.
 *
 * Producer: the runtime `map` tool (`runtime/kernel/tools/defs/map.ts`) POSTs
 * natural inputs (place queries, origin → destination) to the stella.sh
 * resolve endpoint, which turns them into this artifact via Google Places /
 * Directions using a server-side key. No API key ever ships in the client.
 *
 * Renderers: the desktop chat card (`desktop/src/app/chat/MapRouteCard.tsx`)
 * and the mobile chat card embed the hosted stella.sh map page with the
 * artifact encoded into the URL; the page draws the interactive Google Map
 * with a referrer-restricted browser key. The same payload shape is mirrored
 * in the stella-website repo (`src/lib/maps/map-artifact.ts`) and the mobile
 * repo; keep them in sync.
 */

export type MapTravelMode = "driving" | "walking" | "cycling" | "transit";

export type MapArtifactMarker = {
  /** Stable id within the artifact (e.g. "p1", "origin"). */
  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  /** Google place id when the marker came from Places resolution. */
  placeId?: string;
  /** Google rating (1–5) when available. */
  rating?: number;
  ratingCount?: number;
  role?: "origin" | "destination" | "place";
};

export type MapArtifactRouteStep = {
  instruction: string;
  distanceMeters: number;
};

export type MapArtifactRoute = {
  mode: MapTravelMode;
  /** Marker ids for the endpoints. */
  originId: string;
  destinationId: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Human route summary, e.g. "via US-101 N". */
  summary?: string;
  /** Google encoded overview polyline. */
  polyline: string;
  /** Plain-text turn summary (capped); not required to draw the map. */
  steps?: MapArtifactRouteStep[];
};

export type MapRouteArtifact = {
  kind: "map-route";
  version: 1;
  title?: string;
  markers: MapArtifactMarker[];
  route?: MapArtifactRoute;
};

/* -------------------------------------------------------------------------
 * Provider config — the one obvious spot to retarget the hosted map service.
 * The website base can be overridden for dev (e.g. a local `next dev` of
 * stella-website) via STELLA_MAPS_SITE_URL in the runtime process.
 * ---------------------------------------------------------------------- */

export const MAPS_SITE_BASE_URL = "https://stella.sh";
export const MAPS_SITE_URL_ENV = "STELLA_MAPS_SITE_URL";
export const MAPS_RESOLVE_PATH = "/api/maps/resolve";
export const MAPS_EMBED_PATH = "/maps/embed";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isMarker = (value: unknown): value is MapArtifactMarker => {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.id === "string" &&
    typeof marker.name === "string" &&
    isFiniteNumber(marker.lat) &&
    isFiniteNumber(marker.lng)
  );
};

export const isMapRouteArtifact = (
  value: unknown,
): value is MapRouteArtifact => {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Record<string, unknown>;
  if (artifact.kind !== "map-route") return false;
  if (!Array.isArray(artifact.markers) || artifact.markers.length === 0) {
    return false;
  }
  if (!artifact.markers.every(isMarker)) return false;
  const route = artifact.route;
  if (route !== undefined) {
    if (!route || typeof route !== "object") return false;
    const r = route as Record<string, unknown>;
    if (typeof r.polyline !== "string" || r.polyline.length === 0) return false;
    if (!isFiniteNumber(r.distanceMeters) || !isFiniteNumber(r.durationSeconds))
      return false;
  }
  return true;
};

/** base64url without padding; works in both Node and browser contexts. */
const toBase64Url = (json: string): string => {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * URL of the hosted interactive map for this artifact (the stella.sh embed
 * page). Route steps are stripped — the page doesn't need them and they eat
 * URL budget.
 */
export const mapsEmbedUrl = (
  artifact: MapRouteArtifact,
  options?: { mode?: "light" | "dark"; siteBaseUrl?: string },
): string => {
  const base = (options?.siteBaseUrl ?? MAPS_SITE_BASE_URL).replace(/\/+$/, "");
  let slim: MapRouteArtifact = artifact;
  if (artifact.route?.steps) {
    const { steps: _steps, ...route } = artifact.route;
    slim = { ...artifact, route };
  }
  const params = new URLSearchParams({ d: toBase64Url(JSON.stringify(slim)) });
  if (options?.mode) params.set("mode", options.mode);
  params.set("embedded", "1");
  return `${base}${MAPS_EMBED_PATH}?${params.toString()}`;
};

const APPLE_MAPS_DIRFLG: Record<MapTravelMode, string> = {
  driving: "d",
  walking: "w",
  cycling: "c",
  transit: "r",
};

/**
 * Apple Maps deep link for the card's handoff affordance: a route opens
 * turn-by-turn endpoints, a single/multi pin map opens the first marker.
 */
export const appleMapsUrl = (artifact: MapRouteArtifact): string => {
  const params = new URLSearchParams();
  if (artifact.route) {
    const origin = artifact.markers.find(
      (marker) => marker.id === artifact.route?.originId,
    );
    const destination = artifact.markers.find(
      (marker) => marker.id === artifact.route?.destinationId,
    );
    if (origin && destination) {
      params.set("saddr", `${origin.lat},${origin.lng}`);
      params.set("daddr", `${destination.lat},${destination.lng}`);
      params.set("dirflg", APPLE_MAPS_DIRFLG[artifact.route.mode]);
      return `https://maps.apple.com/?${params.toString()}`;
    }
  }
  const first = artifact.markers[0];
  params.set("q", first?.name ?? "Location");
  if (first) params.set("ll", `${first.lat},${first.lng}`);
  return `https://maps.apple.com/?${params.toString()}`;
};
