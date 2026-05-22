import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, SquareArrowOutUpRight } from "lucide-react";
import { usePersonalizedCategories } from "@/app/home/categories";
import { useIdeasSeen } from "@/app/home/use-ideas-seen";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import "./home-suggestion-footer.css";

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

export function HomeSuggestionFooter({
  conversationId,
  onSuggestionClick,
  className,
}: {
  conversationId: string | null;
  onSuggestionClick: (prompt: string) => void;
  className?: string;
}) {
  const { categories, ready: categoriesReady } =
    usePersonalizedCategories(conversationId);
  const { isUnseen, markSeen } = useIdeasSeen(
    conversationId,
    categories,
    categoriesReady,
    true,
  );
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [reports, setReports] = useState<OpenPanelReport[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dropdownInnerRef = useRef<HTMLDivElement | null>(null);
  const [dropdownHeight, setDropdownHeight] = useState(0);

  // Group chips by their source category so the dropdown reads as
  // structured sections (Stella / Task / Skills / Schedule) instead of
  // one flat wall of ~16 pills. Each group renders its own chip row;
  // empty groups are skipped.
  const suggestionGroups = useMemo(
    () =>
      categories
        .filter((category) => category.options.length > 0)
        .map((category) => ({
          label: category.label,
          options: category.options,
        })),
    [categories],
  );

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

  const unseenCategoryCount = useMemo(
    () =>
      categories.reduce(
        (acc, category) => (isUnseen(category.label) ? acc + 1 : acc),
        0,
      ),
    [categories, isUnseen],
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
    if (!ideasOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setIdeasOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIdeasOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ideasOpen]);

  useEffect(() => {
    void loadReports();
    const timer = window.setInterval(() => {
      void loadReports();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadReports]);

  const handleToggleIdeas = useCallback(() => {
    setIdeasOpen((current) => {
      const next = !current;
      if (next) {
        for (const category of categories) markSeen(category.label);
      }
      return next;
    });
  }, [categories, markSeen]);

  const handleSelectOption = useCallback(
    (prompt: string) => {
      onSuggestionClick(prompt);
      setIdeasOpen(false);
    },
    [onSuggestionClick],
  );

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

  // Drive the dropdown container's pixel height off the inner content so
  // opening and closing glide between real heights via a single CSS
  // transition — no snap on mount, no layout shift on category swap.
  useLayoutEffect(() => {
    if (!ideasOpen) {
      setDropdownHeight(0);
      return;
    }
    const node = dropdownInnerRef.current;
    if (!node) return;
    const update = () => {
      if (dropdownInnerRef.current) {
        setDropdownHeight(dropdownInnerRef.current.scrollHeight);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ideasOpen]);

  if (categories.length === 0) return null;

  return (
    <div
      className={`home-suggestion-footer${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className={`home-suggestion-footer__ideas${
          ideasOpen ? " home-suggestion-footer__ideas--open" : ""
        }`}
        aria-expanded={ideasOpen}
        aria-controls="home-suggestion-footer-ideas-panel"
        onClick={handleToggleIdeas}
      >
        <span className="home-suggestion-footer__ideas-label">Ideas</span>
        {unseenCategoryCount > 0 ? (
          <span
            className="home-suggestion-footer__ideas-count"
            aria-label={`${unseenCategoryCount} new`}
          >
            {unseenCategoryCount} new
          </span>
        ) : null}
        <ChevronDown
          className="home-suggestion-footer__ideas-chevron"
          size={14}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      <div
        id="home-suggestion-footer-ideas-panel"
        className="home-suggestion-footer__dropdown-grow"
        style={{ height: `${dropdownHeight}px` }}
        aria-hidden={!ideasOpen}
      >
        <div
          ref={dropdownInnerRef}
          className="home-suggestion-footer__dropdown-inner"
        >
          {ideasOpen && (
            <div
              className="home-suggestion-footer__groups"
              role="listbox"
              aria-label="Suggested ideas"
            >
              {suggestionGroups.map((group) => (
                <section
                  key={group.label}
                  className="home-suggestion-footer__group"
                  aria-label={group.label}
                >
                  <h4 className="home-suggestion-footer__group-label">
                    {group.label}
                  </h4>
                  <ul className="home-suggestion-footer__chips">
                    {group.options.map((option, index) => (
                      <li
                        key={`${option.label}:${index}`}
                        className="home-suggestion-footer__chip-item"
                      >
                        <button
                          type="button"
                          className="home-suggestion-footer__chip"
                          onClick={() => handleSelectOption(option.prompt)}
                        >
                          {option.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {visibleReports.length > 0 ? (
        <section
          className="home-suggestion-footer__reports"
          aria-label="Generated reports"
        >
          <h4 className="home-suggestion-footer__group-label">Reports</h4>
          <ul className="home-suggestion-footer__report-list">
            {visibleReports.map(({ cadence, label, report }) => {
              const fresh =
                !report.openedAt || report.openedAt < report.generatedAt;
              return (
                <li
                  key={cadence}
                  className="home-suggestion-footer__report-item"
                >
                  <button
                    type="button"
                    className={`home-suggestion-footer__report${
                      fresh ? " home-suggestion-footer__report--fresh" : ""
                    }`}
                    title={`Open ${report.title}`}
                    onClick={() => handleOpenReport(cadence)}
                  >
                    <span
                      className="home-suggestion-footer__report-marker"
                      aria-hidden="true"
                    />
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
