import { useMemo, useState } from "react";
import { AlertCircle, ExternalLink } from "@/ui/icons";
import { useTheme } from "@/context/theme-context";
import {
  appleMapsUrl,
  mapsEmbedUrl,
  type MapRouteArtifact,
  type MapTravelMode,
} from "../../../../runtime/contracts/map-artifact.js";
import type { TurnMapArtifact } from "@/features/chat/lib/derive-turn-map-artifacts";
import { notifyAssistantScrollFollowLayoutChange } from "@/shell/chat-scroll-follow";
import "./map-route-card.css";

/**
 * Inline interactive map card for the orchestrator's `map` tool.
 *
 * The map itself is the hosted stella.sh embed page (Google Map, key stays
 * site-side) in an iframe, keyed by the artifact payload + the current theme
 * mode. The footer is native: route distance/duration or pin count on the
 * left, an "Open in Apple Maps" handoff (plain `<a target="_blank">` → OS
 * browser → Apple Maps turn-by-turn) on the right.
 */

const MODE_LABELS: Record<MapTravelMode, string> = {
  driving: "Drive",
  walking: "Walk",
  cycling: "Bike",
  transit: "Transit",
};

const formatDistance = (meters: number): string => {
  if (!Number.isFinite(meters) || meters <= 0) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`;
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} hr ${rest} min` : `${hours} hr`;
};

const cardTitle = (map: MapRouteArtifact): string => {
  if (map.title) return map.title;
  if (map.route) {
    const origin = map.markers.find((m) => m.id === map.route?.originId);
    const destination = map.markers.find(
      (m) => m.id === map.route?.destinationId,
    );
    if (origin && destination) return `${origin.name} → ${destination.name}`;
  }
  if (map.markers.length === 1) return map.markers[0]!.name;
  return `${map.markers.length} places`;
};

const cardSummary = (map: MapRouteArtifact): string => {
  if (map.route) {
    const parts = [
      MODE_LABELS[map.route.mode],
      formatDistance(map.route.distanceMeters),
      formatDuration(map.route.durationSeconds),
    ].filter(Boolean);
    return parts.join(" · ");
  }
  const places = map.markers.length;
  return places === 1 ? "1 place" : `${places} places`;
};

const MapCard = ({ map }: { map: MapRouteArtifact }) => {
  const { resolvedColorMode } = useTheme();
  const [frameFailed, setFrameFailed] = useState(false);
  // Theme mode is captured per URL; a theme switch swaps the iframe src and
  // the embed re-renders in the matching palette.
  const embedUrl = useMemo(
    () => mapsEmbedUrl(map, { mode: resolvedColorMode }),
    [map, resolvedColorMode],
  );
  const handoffUrl = useMemo(() => appleMapsUrl(map), [map]);
  const title = cardTitle(map);
  const summary = cardSummary(map);

  return (
    <div className="map-route-card">
      <div className="map-route-card__frame">
        {frameFailed ? (
          <div className="map-route-card__offline" role="status">
            <AlertCircle size={15} aria-hidden />
            <span>The map preview couldn’t load.</span>
          </div>
        ) : (
          <iframe
            className="map-route-card__iframe"
            src={embedUrl}
            title={`Map: ${title}`}
            loading="lazy"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin"
            onLoad={notifyAssistantScrollFollowLayoutChange}
            onError={() => setFrameFailed(true)}
          />
        )}
      </div>
      <div className="map-route-card__footer">
        <div className="map-route-card__meta">
          <span className="map-route-card__title" title={title}>
            {title}
          </span>
          <span className="map-route-card__summary">{summary}</span>
        </div>
        <a
          className="map-route-card__handoff"
          href={handoffUrl}
          target="_blank"
          rel="noreferrer noopener"
          title="Open in Apple Maps for turn-by-turn navigation"
        >
          Open in Apple Maps
          <ExternalLink size={13} aria-hidden />
        </a>
      </div>
    </div>
  );
};

export const MapRouteCards = ({ cards }: { cards: TurnMapArtifact[] }) => {
  if (cards.length === 0) return null;
  return (
    <div className="map-route-cards">
      {cards.map((card) => (
        <MapCard key={card.id} map={card.map} />
      ))}
    </div>
  );
};
