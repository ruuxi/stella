import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  FileText,
  FolderInput,
} from "lucide-react";

import type {
  ThirdPartyMigrationFinding,
  ThirdPartyMigrationOption,
  ThirdPartyMigrationPreview,
  ThirdPartyMigrationReport,
  ThirdPartyMigrationReportItem,
  ThirdPartyMigrationSelection,
  ThirdPartyMigrationSource,
} from "@/shared/contracts/migration";
import { showToast } from "@/ui/toast";

import "./ThirdPartyMigrationWizard.css";

type ThirdPartyMigrationWizardProps = {
  onImported?: (report: ThirdPartyMigrationReport) => void;
};

const OPTION_ORDER: ThirdPartyMigrationOption[] = [
  "memory",
  "user",
  "sessionHistory",
  "skills",
  "personality",
  "modelConfig",
  "schedules",
];

const OPTION_COPY: Record<ThirdPartyMigrationOption, string> = {
  memory: "Memory",
  user: "User profile",
  sessionHistory: "Session history",
  skills: "Skills",
  personality: "Personality",
  modelConfig: "Model setup",
  schedules: "Schedules",
};

const SOURCE_COPY: Record<ThirdPartyMigrationSource, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

const SOURCE_REPOS: Record<ThirdPartyMigrationSource, string> = {
  hermes: "https://github.com/NousResearch/hermes-agent",
  openclaw: "https://github.com/openclaw/openclaw",
};

const createSelection = (
  preview: ThirdPartyMigrationPreview | null,
): ThirdPartyMigrationSelection =>
  Object.fromEntries(
    OPTION_ORDER.map((option) => [
      option,
      Boolean(
        preview?.findings.find((finding) => finding.option === option)?.found,
      ),
    ]),
  ) as ThirdPartyMigrationSelection;

const getFinding = (
  preview: ThirdPartyMigrationPreview | null,
  option: ThirdPartyMigrationOption,
): ThirdPartyMigrationFinding | null =>
  preview?.findings.find((finding) => finding.option === option) ?? null;

const groupItems = (
  report: ThirdPartyMigrationReport | null,
  status: ThirdPartyMigrationReportItem["status"],
) => report?.items.filter((item) => item.status === status) ?? [];

function MigrationReportList({
  title,
  items,
}: {
  title: string;
  items: ThirdPartyMigrationReportItem[];
}) {
  return (
    <section className="migration-report-section">
      <div className="migration-report-section__title">{title}</div>
      {items.length > 0 ? (
        <ul className="migration-report-list">
          {items.map((item, index) => (
            <li key={`${item.kind}-${index}`}>
              <span className="migration-report-list__kind">{item.kind}</span>
              <span>{item.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="migration-report-empty">None.</div>
      )}
    </section>
  );
}

export function ThirdPartyMigrationWizard({
  onImported,
}: ThirdPartyMigrationWizardProps) {
  const [previews, setPreviews] = useState<ThirdPartyMigrationPreview[]>([]);
  const [selectedSource, setSelectedSource] =
    useState<ThirdPartyMigrationSource | null>(null);
  const [selection, setSelection] = useState<ThirdPartyMigrationSelection>({});
  const [report, setReport] = useState<ThirdPartyMigrationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPreview = useMemo(
    () => previews.find((preview) => preview.source === selectedSource) ?? null,
    [previews, selectedSource],
  );
  const foundPreviews = useMemo(
    () => previews.filter((preview) => preview.found),
    [previews],
  );
  const importedItems = groupItems(report, "imported");
  const skippedItems = groupItems(report, "skipped");
  const manualItems = [
    ...groupItems(report, "manual"),
    ...groupItems(report, "error"),
  ];

  const refresh = useCallback(async () => {
    const migrationApi = window.electronAPI?.migration;
    if (!migrationApi?.detectSources) {
      setError("Import is unavailable in this window.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const nextPreviews = await migrationApi.detectSources();
      setPreviews(nextPreviews);
      const firstFound = nextPreviews.find((preview) => preview.found) ?? null;
      setSelectedSource((current) => {
        if (current && nextPreviews.some((preview) => preview.source === current)) {
          return current;
        }
        return firstFound?.source ?? null;
      });
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to check for imports.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setSelection(createSelection(selectedPreview));
    setReport(null);
  }, [selectedPreview]);

  const toggleOption = useCallback((option: ThirdPartyMigrationOption) => {
    setSelection((current) => ({
      ...current,
      [option]: !current[option],
    }));
  }, []);

  const runImport = useCallback(async () => {
    if (!selectedPreview) return;
    const migrationApi = window.electronAPI?.migration;
    if (!migrationApi?.run) {
      setError("Import is unavailable in this window.");
      return;
    }

    setRunning(true);
    setError(null);
    try {
      const nextReport = await migrationApi.run({
        source: selectedPreview.source,
        sourceRoot: selectedPreview.sourceRoot,
        selection,
      });
      setReport(nextReport);
      onImported?.(nextReport);
      showToast({
        title: `Imported from ${SOURCE_COPY[selectedPreview.source]}`,
        description: "A migration report is ready.",
      });
    } catch (nextError) {
      const message =
        nextError instanceof Error ? nextError.message : "Import failed.";
      setError(message);
      showToast({
        title: "Import failed",
        description: message,
        variant: "error",
      });
    } finally {
      setRunning(false);
    }
  }, [onImported, selectedPreview, selection]);

  const openReport = useCallback(() => {
    if (!report?.markdownPath) return;
    void window.electronAPI?.system?.openPath?.(report.markdownPath);
  }, [report]);

  const selectedCount = OPTION_ORDER.filter((option) => selection[option])
    .length;

  return (
    <div className="migration-wizard">
      <div className="migration-wizard__intro">
        <div className="migration-wizard__icon" aria-hidden="true">
          {report ? <FileText size={19} /> : <FolderInput size={20} />}
        </div>
        <div>
          <div className="migration-wizard__title">
            {report ? "Import report" : "Import from another assistant"}
          </div>
          <p className="migration-wizard__desc">
            Stella reads the old install and writes only to Stella's own files.
            No live link is kept.
          </p>
        </div>
      </div>

      {error ? (
        <div className="migration-wizard__error" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="migration-wizard__loading">Checking this computer...</div>
      ) : foundPreviews.length === 0 ? (
        <div className="migration-empty">
          <div className="migration-empty__title">
            No Hermes or OpenClaw install found.
          </div>
          <div className="migration-empty__body">
            Stella checks the standard local folders. You can still connect
            accounts and set models from Settings.
          </div>
        </div>
      ) : report ? (
        <div className="migration-report">
          <MigrationReportList title="Imported" items={importedItems} />
          <MigrationReportList title="Skipped" items={skippedItems} />
          <MigrationReportList title="Needs review" items={manualItems} />
          <div className="migration-report__note">
            Channels skipped - re-enable in Stella settings (no setup required).
          </div>
          <button
            type="button"
            className="pill-btn migration-wizard__primary"
            onClick={openReport}
          >
            Open report
          </button>
        </div>
      ) : (
        <>
          <div className="migration-source-list" role="tablist">
            {foundPreviews.map((preview) => (
              <button
                key={preview.source}
                type="button"
                className="migration-source-card"
                data-active={selectedSource === preview.source || undefined}
                onClick={() => setSelectedSource(preview.source)}
              >
                <span className="migration-source-card__name">
                  Import from {SOURCE_COPY[preview.source]}
                </span>
                <span className="migration-source-card__path">
                  {preview.sourceRoot}
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            ))}
          </div>

          <div className="migration-checklist">
            {OPTION_ORDER.map((option) => {
              const finding = getFinding(selectedPreview, option);
              const disabled = !finding?.found;
              return (
                <label
                  key={option}
                  className="migration-check-row"
                  data-disabled={disabled || undefined}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(selection[option])}
                    disabled={disabled || running}
                    onChange={() => toggleOption(option)}
                  />
                  <span className="migration-check-row__box">
                    <Check size={13} aria-hidden="true" />
                  </span>
                  <span className="migration-check-row__text">
                    <span className="migration-check-row__label">
                      {OPTION_COPY[option]}
                    </span>
                    <span className="migration-check-row__meta">
                      {finding?.found
                        ? `${finding.count} found`
                        : "Nothing found"}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          {selectedPreview ? (
            <a
              className="migration-wizard__credit"
              href={SOURCE_REPOS[selectedPreview.source]}
              onClick={(event) => {
                event.preventDefault();
                void window.electronAPI?.system?.openExternal?.(
                  SOURCE_REPOS[selectedPreview.source],
                );
              }}
            >
              Source project: {SOURCE_COPY[selectedPreview.source]}
            </a>
          ) : null}

          <button
            type="button"
            className="pill-btn pill-btn--primary migration-wizard__primary"
            disabled={!selectedPreview || selectedCount === 0 || running}
            onClick={() => void runImport()}
          >
            {running ? "Importing..." : "Run import"}
          </button>
        </>
      )}
    </div>
  );
}
