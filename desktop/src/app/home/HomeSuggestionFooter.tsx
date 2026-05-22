import { useCallback, useEffect, useMemo, useState } from "react";
import { Shuffle, SquareArrowOutUpRight } from "lucide-react";
import { usePersonalizedCategories } from "@/app/home/categories";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import "./home-suggestion-footer.css";

const VISIBLE_SUGGESTIONS = 5;

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

// User-facing cadence names. "Pulse" replaces the cryptic "4h" so the row
// reads as three named reports, not a mix of duration-shorthand and
// frequency-noun. Order matches generation cadence (most → least frequent).
const REPORT_PILLS: ReadonlyArray<{ cadence: ReportCadence; label: string }> = [
  { cadence: "4h", label: "Pulse" },
  { cadence: "daily", label: "Daily" },
  { cadence: "weekly", label: "Weekly" },
];

const formatReportTime = (timestamp: number): string => {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
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

export function HomeSuggestionFooter({
  conversationId,
  onSuggestionClick,
  className,
}: {
  conversationId: string | null;
  onSuggestionClick: (prompt: string) => void;
  className?: string;
}) {
  const { categories } = usePersonalizedCategories(conversationId);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [reports, setReports] = useState<OpenPanelReport[]>([]);

  const flatSuggestions = useMemo(
    () => interleaveByCategory(categories),
    [categories],
  );

  const visibleSuggestions = useMemo(() => {
    if (flatSuggestions.length === 0) return [];
    const count = Math.min(VISIBLE_SUGGESTIONS, flatSuggestions.length);
    const offset = shuffleSeed % flatSuggestions.length;
    const sliced: FlatSuggestion[] = [];
    for (let i = 0; i < count; i++) {
      sliced.push(flatSuggestions[(offset + i) % flatSuggestions.length]);
    }
    return sliced;
  }, [flatSuggestions, shuffleSeed]);

  const canShuffle = flatSuggestions.length > VISIBLE_SUGGESTIONS;

  const handleShuffle = useCallback(() => {
    setShuffleSeed((seed) => seed + VISIBLE_SUGGESTIONS);
  }, []);

  const reportsByCadence = useMemo(() => {
    const map = new Map<ReportCadence, OpenPanelReport>();
    for (const report of reports) map.set(report.cadence, report);
    return map;
  }, [reports]);

  const visibleReports = useMemo(
    () =>
      REPORT_PILLS.map((pill) => {
        const report = reportsByCadence.get(pill.cadence);
        if (!report) return null;
        return { ...pill, report };
      }).filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    [reportsByCadence],
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
      const report = reportsByCadence.get(cadence);
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
    [reportsByCadence],
  );

  if (visibleSuggestions.length === 0 && visibleReports.length === 0) {
    return null;
  }

  return (
    <div className={`home-suggestion-footer${className ? ` ${className}` : ""}`}>
      {visibleSuggestions.length > 0 ? (
        <section
          className="home-suggestion-footer__section"
          aria-label="Suggested ideas"
        >
          <header className="home-suggestion-footer__section-header">
            <h4 className="home-suggestion-footer__section-label">Try</h4>
            {canShuffle ? (
              <button
                type="button"
                className="home-suggestion-footer__shuffle"
                onClick={handleShuffle}
                aria-label="Shuffle suggestions"
                title="Shuffle"
              >
                <Shuffle size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            ) : null}
          </header>
          <ul className="home-suggestion-footer__list">
            {visibleSuggestions.map((suggestion, index) => (
              <li
                key={`${suggestion.category}:${suggestion.label}:${index}`}
                className="home-suggestion-footer__item"
              >
                <button
                  type="button"
                  className="home-suggestion-footer__suggestion"
                  onClick={() => onSuggestionClick(suggestion.prompt)}
                  title={suggestion.prompt}
                >
                  <span className="home-suggestion-footer__suggestion-label">
                    {suggestion.label}
                  </span>
                  <span
                    className="home-suggestion-footer__suggestion-tag"
                    aria-hidden="true"
                  >
                    {suggestion.category}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {visibleReports.length > 0 ? (
        <section
          className="home-suggestion-footer__section home-suggestion-footer__section--reports"
          aria-label="Generated reports"
        >
          <header className="home-suggestion-footer__section-header">
            <h4 className="home-suggestion-footer__section-label">Reports</h4>
          </header>
          <ul className="home-suggestion-footer__list">
            {visibleReports.map(({ cadence, label, report }) => {
              const fresh =
                !report.openedAt || report.openedAt < report.generatedAt;
              return (
                <li
                  key={cadence}
                  className="home-suggestion-footer__item"
                >
                  <button
                    type="button"
                    className={`home-suggestion-footer__report${
                      fresh ? " home-suggestion-footer__report--fresh" : ""
                    }`}
                    title={`Open ${report.title}`}
                    onClick={() => handleOpenReport(cadence)}
                  >
                    <span className="home-suggestion-footer__report-label">
                      {label}
                    </span>
                    <span className="home-suggestion-footer__report-meta">
                      {formatReportTime(report.generatedAt)}
                    </span>
                    <SquareArrowOutUpRight
                      className="home-suggestion-footer__report-icon"
                      size={12}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
