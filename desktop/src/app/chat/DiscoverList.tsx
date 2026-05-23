/**
 * Body of the Discover card in the chat workspace strip. Renders one
 * mixed stream of items: freshly generated cadence reports (newest
 * first) and personalized suggestion prompts that fill the remaining
 * slots, capped at MAX_DISCOVER_ITEMS overall.
 *
 * Reports and suggestions share row geometry; they're distinguished by
 * the kind of right-side metadata (relative timestamp vs uppercase
 * category tag) and by weight (fresh report > suggestion > read
 * report). Fresh reports carry a small status dot until the user hovers
 * them. Shuffle lives on the parent card header and only re-rolls the
 * suggestion fill.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { SquareArrowOutUpRight } from "lucide-react";
import { usePersonalizedCategories } from "@/app/home/categories";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import "./discover-list.css";

export const MAX_DISCOVER_ITEMS = 4;

// One-shot localStorage flag: flips true the first time the user
// invokes shuffle. Drives the small first-run hint dot on the
// shuffle button so the affordance is discoverable without
// becoming a permanent decoration.
const SHUFFLE_SEEN_STORAGE_KEY = "stella.discover.shuffleSeen";

const readShuffleSeen = (): boolean => {
  try {
    return window.localStorage.getItem(SHUFFLE_SEEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

// When both kinds of content exist, reserve at least 2 slots for
// suggestions so a flurry of fresh reports can never drown them out.
// Reports still grow to MAX_DISCOVER_ITEMS when the suggestion pool is
// empty (rare — DEFAULT_CATEGORIES guarantees a baseline).
const MAX_REPORTS_WITH_SUGGESTIONS = 2;

type ReportCadence = "4h" | "daily" | "weekly";

type OpenPanelReport = {
  cadence: ReportCadence;
  label: string;
  title: string;
  filePath: string;
  generatedAt: number;
  windowStartAt: number;
  openedAt?: number;
};

const REPORT_LABELS: Record<ReportCadence, string> = {
  "4h": "Pulse",
  daily: "Daily",
  weekly: "Weekly",
};

const formatReportTime = (timestamp: number): string => {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

type FlatSuggestion = {
  label: string;
  prompt: string;
  category: string;
};

// Interleave by category so any N-slice still spans Stella / Task /
// Skills / Schedule rather than clumping into one category at the top.
function interleaveByCategory(
  categories: ReadonlyArray<{
    label: string;
    options: ReadonlyArray<{ label: string; prompt: string }>;
  }>,
): FlatSuggestion[] {
  const cursors = categories.map(() => 0);
  const result: FlatSuggestion[] = [];
  let added = true;
  while (added) {
    added = false;
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      const idx = cursors[i];
      if (idx < category.options.length) {
        result.push({
          label: category.options[idx].label,
          prompt: category.options[idx].prompt,
          category: category.label,
        });
        cursors[i] = idx + 1;
        added = true;
      }
    }
  }
  return result;
}

export type DiscoverItem =
  | {
      kind: "report";
      key: string;
      label: string;
      meta: string;
      fresh: boolean;
      onOpen: () => void;
      onHover: () => void;
    }
  | {
      kind: "suggestion";
      key: string;
      label: string;
      category: string;
      prompt: string;
    };

export function useDiscoverItems(conversationId: string | null): {
  items: DiscoverItem[];
  canShuffle: boolean;
  shuffle: () => void;
  shuffleSeen: boolean;
} {
  const { categories } = usePersonalizedCategories(conversationId);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [shuffleSeen, setShuffleSeen] = useState<boolean>(readShuffleSeen);
  const [reports, setReports] = useState<OpenPanelReport[]>([]);

  const flatSuggestions = useMemo(
    () => interleaveByCategory(categories),
    [categories],
  );

  const loadReports = useCallback(async () => {
    try {
      const next = await window.electronAPI?.display?.listOpenPanelReports?.();
      if (Array.isArray(next)) setReports(next as OpenPanelReport[]);
    } catch {
      setReports([]);
    }
  }, []);

  useEffect(() => {
    void loadReports();
    const timer = window.setInterval(() => {
      void loadReports();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadReports]);

  const handleOpenReport = useCallback(
    async (cadence: ReportCadence) => {
      const report = reports.find((entry) => entry.cadence === cadence);
      if (!report) return;
      try {
        const opened =
          await window.electronAPI?.display?.markOpenPanelReportOpened?.({
            cadence,
          });
        if (opened) {
          setReports((current) =>
            current.map((entry) =>
              entry.cadence === cadence ? opened : entry,
            ),
          );
        }
      } catch {
        // Opening the local report is still useful if the seen marker fails.
      }
      displayTabs.openTab(
        payloadToTabSpec({
          kind: "canvas-html",
          filePath: report.filePath,
          title: report.title,
          slug: `open-panel-${cadence}`,
          createdAt: report.generatedAt,
        }),
      );
    },
    [reports],
  );

  const handleHoverReport = useCallback(
    (cadence: ReportCadence) => {
      const report = reports.find((entry) => entry.cadence === cadence);
      if (
        !report ||
        (report.openedAt && report.openedAt >= report.generatedAt)
      ) {
        return;
      }
      const seenReport: OpenPanelReport = { ...report, openedAt: Date.now() };
      setReports((current) =>
        current.map((entry) =>
          entry.cadence === cadence ? seenReport : entry,
        ),
      );
      const markOpened = window.electronAPI?.display?.markOpenPanelReportOpened;
      if (!markOpened) return;
      void markOpened({ cadence })
        .then((opened) => {
          if (!opened) return;
          setReports((current) =>
            current.map((entry) =>
              entry.cadence === cadence ? (opened as OpenPanelReport) : entry,
            ),
          );
        })
        .catch(() => {
          // Keep the optimistic clear for this session; the next report
          // poll will restore the dot if persistence failed.
        });
    },
    [reports],
  );

  const items = useMemo<DiscoverItem[]>(() => {
    const reportCap =
      flatSuggestions.length === 0
        ? MAX_DISCOVER_ITEMS
        : MAX_REPORTS_WITH_SUGGESTIONS;

    const reportItems: DiscoverItem[] = [...reports]
      .sort((a, b) => b.generatedAt - a.generatedAt)
      .slice(0, reportCap)
      .map((report) => ({
        kind: "report",
        key: `report:${report.cadence}`,
        label: REPORT_LABELS[report.cadence],
        meta: formatReportTime(report.generatedAt),
        fresh: !report.openedAt || report.openedAt < report.generatedAt,
        onOpen: () => void handleOpenReport(report.cadence),
        onHover: () => handleHoverReport(report.cadence),
      }));

    const remaining = MAX_DISCOVER_ITEMS - reportItems.length;
    if (remaining <= 0 || flatSuggestions.length === 0) return reportItems;

    const offset = shuffleSeed % flatSuggestions.length;
    const take = Math.min(remaining, flatSuggestions.length);
    const suggestionItems: DiscoverItem[] = [];
    for (let i = 0; i < take; i++) {
      const suggestion = flatSuggestions[(offset + i) % flatSuggestions.length];
      suggestionItems.push({
        kind: "suggestion",
        key: `suggestion:${suggestion.category}:${suggestion.label}:${i}`,
        label: suggestion.label,
        category: suggestion.category,
        prompt: suggestion.prompt,
      });
    }
    return [...reportItems, ...suggestionItems];
  }, [
    flatSuggestions,
    handleHoverReport,
    handleOpenReport,
    reports,
    shuffleSeed,
  ]);

  // Shuffle is only meaningful when the suggestion pool exceeds the
  // number of slots suggestions currently occupy. Mirrors the cap used
  // in `items` so the math agrees with what the user actually sees.
  const reportSlotsTaken = Math.min(
    reports.length,
    flatSuggestions.length === 0
      ? MAX_DISCOVER_ITEMS
      : MAX_REPORTS_WITH_SUGGESTIONS,
  );
  const suggestionSlots = MAX_DISCOVER_ITEMS - reportSlotsTaken;
  const canShuffle =
    suggestionSlots > 0 && flatSuggestions.length > suggestionSlots;

  const shuffle = useCallback(() => {
    setShuffleSeed((seed) => seed + MAX_DISCOVER_ITEMS);
    setShuffleSeen((seen) => {
      if (seen) return seen;
      try {
        window.localStorage.setItem(SHUFFLE_SEEN_STORAGE_KEY, "1");
      } catch {
        // Storage may be unavailable; the in-memory flag still hides
        // the dot for the rest of this session.
      }
      return true;
    });
  }, []);

  return { items, canShuffle, shuffle, shuffleSeen };
}

export function DiscoverList({
  items,
  onSuggestionClick,
  className,
}: {
  items: ReadonlyArray<DiscoverItem>;
  onSuggestionClick: (prompt: string) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={`discover-list${className ? ` ${className}` : ""}`}>
      {items.map((item) => {
        if (item.kind === "report") {
          return (
            <li key={item.key} className="discover-list__item">
              <button
                type="button"
                className={`discover-list__row discover-list__row--report${
                  item.fresh ? " discover-list__row--fresh" : ""
                }`}
                title={`Open ${item.label}`}
                onClick={item.onOpen}
                onMouseEnter={item.onHover}
              >
                <span className="discover-list__report-title">
                  <span className="discover-list__label">{item.label}</span>
                  {item.fresh ? (
                    <span
                      className="discover-list__status-dot"
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
                <span className="discover-list__meta discover-list__meta--time">
                  {item.meta}
                </span>
                <SquareArrowOutUpRight
                  className="discover-list__hover-icon"
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        }
        return (
          <li key={item.key} className="discover-list__item">
            <button
              type="button"
              className="discover-list__row discover-list__row--suggestion"
              onClick={() => onSuggestionClick(item.prompt)}
              title={item.prompt}
            >
              <span className="discover-list__label">{item.label}</span>
              <span className="discover-list__meta discover-list__meta--tag">
                {item.category}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
