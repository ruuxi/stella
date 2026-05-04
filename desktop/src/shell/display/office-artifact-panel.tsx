import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Presentation,
} from "lucide-react";
import type {
  OfficePreviewFormat,
  OfficePreviewRef,
  OfficePreviewSnapshot,
} from "../../../../runtime/contracts/office-preview.js";
import { useOfficePreview } from "@/app/chat/office-preview-store";
import { useFilePreviewActions } from "@/app/chat/hooks/use-file-preview-actions";

const ZOOM_OPTIONS = [75, 100, 125, 150] as const;

type ArtifactKind = "document" | "spreadsheet" | "presentation";

const formatFromPath = (sourcePath: string): OfficePreviewFormat => {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  if (lower.endsWith(".pptx")) return "pptx";
  return null;
};

const kindForFormat = (format: OfficePreviewFormat): ArtifactKind => {
  if (format === "xlsx") return "spreadsheet";
  if (format === "pptx") return "presentation";
  return "document";
};

const labelForKind = (kind: ArtifactKind) => {
  if (kind === "spreadsheet") return "Spreadsheet";
  if (kind === "presentation") return "Presentation";
  return "Document";
};

const titleForPreview = (
  previewRef: OfficePreviewRef,
  snapshot?: OfficePreviewSnapshot,
) => snapshot?.title ?? previewRef.title;

const parsePreviewMeta = (html?: string, kind?: ArtifactKind) => {
  if (!html || typeof DOMParser === "undefined") {
    return { count: 0, sheets: [] as string[] };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  if (kind === "spreadsheet") {
    const sheets = Array.from(doc.querySelectorAll(".sheet-tab"))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);
    return { count: sheets.length, sheets };
  }

  if (kind === "presentation") {
    return {
      count: doc.querySelectorAll(".slide-container, [data-slide-index]").length,
      sheets: [] as string[],
    };
  }

  return {
    count: doc.querySelectorAll("section, article, .page, [data-page]").length,
    sheets: [] as string[],
  };
};

const injectPreviewChrome = (html: string, zoomPercent: number) => {
  const style = `
<style id="stella-artifact-preview-style">
  html {
    background: #f7f7f8 !important;
  }
  body {
    zoom: ${zoomPercent / 100};
  }
  .file-title {
    display: none !important;
  }
</style>`;
  const next = html.includes("</head>")
    ? html.replace("</head>", `${style}</head>`)
    : `${style}${html}`;
  return next;
};

const StatusPanel = ({
  error,
  loading,
}: {
  error?: string | null;
  loading?: boolean;
}) => (
  <div className="display-artifact-status">
    <div
      className={
        loading
          ? "display-artifact-status__text loading-shimmer-pure-text"
          : "display-artifact-status__text"
      }
    >
      {loading
        ? "Preparing preview..."
        : error?.trim() || "Couldn't load this preview"}
    </div>
  </div>
);

const KindIcon = ({ kind }: { kind: ArtifactKind }) => {
  if (kind === "spreadsheet") return <FileSpreadsheet size={15} />;
  if (kind === "presentation") return <Presentation size={15} />;
  return <FileText size={15} />;
};

export function OfficeArtifactPanel({
  previewRef,
}: {
  previewRef: OfficePreviewRef;
}) {
  const snapshot = useOfficePreview(previewRef.sessionId);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const format = snapshot?.format ?? formatFromPath(previewRef.sourcePath);
  const kind = kindForFormat(format);
  const title = titleForPreview(previewRef, snapshot);
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: previewRef.sourcePath,
    suggestedName: title,
  });

  const meta = useMemo(
    () => parsePreviewMeta(snapshot?.html, kind),
    [snapshot?.html, kind],
  );
  const srcDoc = useMemo(
    () =>
      snapshot?.html
        ? injectPreviewChrome(snapshot.html, zoomPercent)
        : undefined,
    [snapshot?.html, zoomPercent],
  );

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || kind !== "spreadsheet") return;
    const applySheetSelection = (index: number) => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc
        .querySelectorAll<HTMLElement>(".sheet-tab[data-sheet]")
        .forEach((tab) => {
          tab.classList.toggle(
            "active",
            Number(tab.getAttribute("data-sheet")) === index,
          );
        });
      doc
        .querySelectorAll<HTMLElement>(".sheet-content[data-sheet]")
        .forEach((content) => {
          content.classList.toggle(
            "active",
            Number(content.getAttribute("data-sheet")) === index,
          );
        });
    };
    const attachSheetHandlers = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc
        .querySelectorAll<HTMLElement>(".sheet-tab[data-sheet]")
        .forEach((tab) => {
          tab.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const index = Number(tab.getAttribute("data-sheet"));
            if (Number.isFinite(index)) applySheetSelection(index);
          });
          tab.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            const index = Number(tab.getAttribute("data-sheet"));
            if (Number.isFinite(index)) applySheetSelection(index);
          });
        });
      const active =
        doc.querySelector<HTMLElement>(".sheet-tab.active[data-sheet]") ??
        doc.querySelector<HTMLElement>(".sheet-tab[data-sheet]");
      const activeIndex = Number(active?.getAttribute("data-sheet"));
      if (Number.isFinite(activeIndex)) applySheetSelection(activeIndex);
      active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const handleLoad = () => {
      attachSheetHandlers();
    };
    frame.addEventListener("load", handleLoad);
    const timeout = window.setTimeout(attachSheetHandlers, 0);
    return () => {
      window.clearTimeout(timeout);
      frame.removeEventListener("load", handleLoad);
    };
  }, [kind, srcDoc]);

  const ready = snapshot?.status === "ready" && Boolean(srcDoc);
  const error =
    snapshot?.status === "error"
      ? snapshot.error || "The preview session reported an error."
      : null;
  const loading = !snapshot || snapshot.status === "starting";

  const countLabel =
    kind === "spreadsheet" && meta.count > 0
      ? `${meta.count} sheet${meta.count === 1 ? "" : "s"}`
      : kind === "presentation" && meta.count > 0
        ? `${meta.count} slide${meta.count === 1 ? "" : "s"}`
        : labelForKind(kind);

  return (
    <section
      className={`display-artifact-panel display-artifact-panel--${kind}`}
    >
      <header className="display-artifact-panel__header">
        <div className="display-artifact-panel__identity">
          <div className="display-artifact-panel__icon" aria-hidden>
            <KindIcon kind={kind} />
          </div>
          <div className="display-artifact-panel__title-group">
            <div className="display-artifact-panel__eyebrow">
              {labelForKind(kind)}
            </div>
            <div
              className="display-artifact-panel__title"
              title={previewRef.sourcePath}
            >
              {title}
            </div>
          </div>
        </div>

        <div className="display-artifact-panel__center">{countLabel}</div>

        <div className="display-artifact-panel__actions">
          <select
            className="display-artifact-panel__zoom"
            aria-label="Preview zoom"
            value={zoomPercent}
            onChange={(event) => {
              setZoomPercent(Number(event.target.value));
            }}
          >
            {ZOOM_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}%
              </option>
            ))}
          </select>
          <button
            type="button"
            className="display-artifact-panel__action"
            onClick={() => {
              window.electronAPI?.system?.showItemInFolder?.(
                previewRef.sourcePath,
              );
            }}
            title="Reveal in Finder"
            aria-label="Reveal in Finder"
          >
            <FolderOpen size={14} />
          </button>
          <button
            type="button"
            className="display-artifact-panel__action"
            onClick={handleSave}
            title="Save"
            aria-label="Save"
          >
            <Download size={14} />
          </button>
          <button
            type="button"
            className="display-artifact-panel__action"
            onClick={handleCopy}
            title="Copy"
            aria-label="Copy"
          >
            <Copy size={14} />
          </button>
        </div>
      </header>

      <div className="display-artifact-panel__body">
        {ready ? (
          <iframe
            ref={frameRef}
            className="display-artifact-panel__frame"
            title={`${labelForKind(kind)} preview: ${title}`}
            sandbox="allow-scripts allow-same-origin"
            srcDoc={srcDoc}
          />
        ) : (
          <StatusPanel error={error} loading={loading} />
        )}
      </div>

      {(actionStatus || snapshot?.status === "ready") && (
        <footer className="display-artifact-panel__footer">
          <span>
            {snapshot?.updatedAt
              ? `Updated ${new Date(snapshot.updatedAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : "Live preview"}
          </span>
          {actionStatus && <strong>{actionStatus}</strong>}
        </footer>
      )}
    </section>
  );
}
