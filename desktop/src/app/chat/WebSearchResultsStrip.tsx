import { useMemo, useState } from "react";
import { Globe } from "@/ui/icons";
import type { WebSearchImageHit } from "@/features/chat/lib/derive-turn-web-search";
import { notifyAssistantScrollFollowLayoutChange } from "@/shell/chat-scroll-follow";
import "./web-search-results-strip.css";

/**
 * Claude-style "Results from the web" image strip.
 *
 * Renders the thumbnailable hits from a turn's web search as a single row
 * of source cards. Each card opens its URL in the OS browser via the
 * Electron external-link handlers (plain `<a target="_blank">`). Images
 * that fail to load (hotlink protection, dead URLs) drop out silently;
 * if none survive, the strip renders nothing.
 */
const prettySource = (url: string): string => {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
  } catch {
    return "";
  }
};

export const WebSearchResultsStrip = ({
  results,
}: {
  results: WebSearchImageHit[];
}) => {
  const [failed, setFailed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const visible = useMemo(
    () => results.filter((hit) => !failed.has(hit.url)),
    [failed, results],
  );

  if (visible.length === 0) return null;

  return (
    <div className="web-search-results">
      <div
        className="web-search-results__row"
        role="list"
        aria-label="Web search results"
      >
        {visible.map((hit) => {
          const source = prettySource(hit.url);
          return (
            <a
              key={hit.url}
              className="web-search-results__card"
              href={hit.url}
              target="_blank"
              rel="noreferrer noopener"
              role="listitem"
              title={hit.title || source || hit.url}
            >
              <img
                className="web-search-results__image"
                src={hit.image}
                alt={hit.title || source}
                loading="lazy"
                onLoad={notifyAssistantScrollFollowLayoutChange}
                onError={() =>
                  setFailed((prev) => {
                    const next = new Set(prev);
                    next.add(hit.url);
                    return next;
                  })
                }
              />
              <span className="web-search-results__scrim" aria-hidden />
              <span className="web-search-results__source">
                {hit.favicon ? (
                  <img
                    className="web-search-results__favicon"
                    src={hit.favicon}
                    alt=""
                    aria-hidden
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <Globe className="web-search-results__source-icon" aria-hidden />
                )}
                <span className="web-search-results__source-label">
                  {source}
                </span>
              </span>
            </a>
          );
        })}
      </div>
      <div className="web-search-results__caption">Results from the web</div>
    </div>
  );
};
