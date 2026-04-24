/**
 * Per-kind viewer components used by the Display sidebar's tab manager.
 *
 * Each component is a thin wrapper that delegates to the existing card UI
 * (MediaPreviewCard sub-renderers, OfficePreviewCard, PdfViewerCard,
 * morphdom HTML application). The wrappers exist so the tab spec's
 * `render()` function can be a single `createElement(Component, props)`
 * call — no per-call branching, no `kind` discriminator inside the render
 * path.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { OfficePreviewRef } from "@/shared/contracts/office-preview";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { PdfViewerCard } from "@/app/chat/PdfViewerCard";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import { applyMorphdomHtml } from "@/shell/apply-morphdom-html";
import { useFilePreviewActions } from "@/app/chat/hooks/use-file-preview-actions";

type WithMediaMeta = {
  prompt?: string;
  capability?: string;
};

export const HtmlTabContent = ({ html }: { html: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    applyMorphdomHtml(el, "display-sidebar__content", html, {
      executeScripts: true,
    });
  }, [html]);

  // The legacy DisplaySidebar handled action delegation (`data-action="send-
  // message"`) at the container level. Preserve it here so the same HTML
  // payloads keep working.
  return (
    <div
      ref={ref}
      className="display-sidebar__content"
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest(
          "[data-action]",
        ) as HTMLElement | null;
        if (!el) return;
        if (el.getAttribute("data-action") === "send-message") {
          const prompt = el.getAttribute("data-prompt");
          if (prompt) {
            window.dispatchEvent(
              new CustomEvent("stella:send-message", {
                detail: { text: prompt },
              }),
            );
          }
        }
      }}
    />
  );
};

export const OfficeTabContent = ({
  previewRef,
}: {
  previewRef: OfficePreviewRef;
}) => (
  <div className="display-sidebar__rich">
    <OfficePreviewCard previewRef={previewRef} />
  </div>
);

const startOfficePreviewForPath = (
  filePath: string,
): Promise<OfficePreviewRef> => {
  return (async () => {
    const api = window.electronAPI?.officePreview;
    if (typeof api?.start !== "function") {
      throw new Error("Office previews require the Stella desktop app.");
    }
    return await api.start(filePath);
  })();
};

export const OfficeFileTabContent = ({
  filePath,
  title,
  refreshToken,
}: {
  filePath: string;
  title?: string;
  refreshToken?: number;
}) => {
  const [previewRef, setPreviewRef] = useState<OfficePreviewRef | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewRef(null);
    setError(null);
    void startOfficePreviewForPath(filePath)
      .then((ref) => {
        if (!cancelled) setPreviewRef(title ? { ...ref, title } : ref);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, title, refreshToken]);

  if (previewRef) {
    return <OfficeTabContent previewRef={previewRef} />;
  }

  return (
    <div className="display-sidebar__rich">
      <div className="display-file-preview display-file-preview--placeholder">
        <div className="display-file-preview__eyebrow">
          {error ? "Preview error" : "Preparing preview"}
        </div>
        <div className="display-file-preview__title" title={filePath}>
          {title ?? filePath.split(/[\\/]/).pop() ?? "Document"}
        </div>
        {error && <div className="display-file-preview__error">{error}</div>}
      </div>
    </div>
  );
};

const textDecoder = new TextDecoder("utf-8");

const parseDelimitedRows = (
  text: string,
  delimiter: "," | "\t",
): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

export const DelimitedTableTabContent = ({
  filePath,
  title,
}: {
  filePath: string;
  title?: string;
}) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    filePath,
    "Spreadsheet preview requires the Stella desktop app.",
  );
  const delimiter = filePath.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const rows = useMemo(() => {
    if (!bytes) return [];
    return parseDelimitedRows(textDecoder.decode(bytes), delimiter).slice(
      0,
      1_000,
    );
  }, [bytes, delimiter]);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: filePath,
    suggestedName: title ?? filePath.split(/[\\/]/).pop() ?? "data.csv",
  });

  return (
    <div className="display-sidebar__rich display-sidebar__rich--table">
      <section className="display-file-preview display-file-preview--table">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">Spreadsheet</span>
            <div className="display-file-preview__title" title={filePath}>
              {title ?? filePath.split(/[\\/]/).pop() ?? "Spreadsheet"}
            </div>
          </div>
          <div className="display-file-preview__actions">
            <button type="button" onClick={handleSave}>
              Save
            </button>
            <button type="button" onClick={handleCopy}>
              Copy
            </button>
            {actionStatus && <span>{actionStatus}</span>}
          </div>
        </header>
        {error ? (
          <div className="display-file-preview__error">{error}</div>
        ) : loading ? (
          <div className="display-file-preview__empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="display-file-preview__empty">No rows found.</div>
        ) : (
          <div className="display-file-preview__table-wrap">
            <table className="display-file-preview__table">
              <thead>
                <tr>
                  {Array.from({ length: columnCount }, (_, index) => (
                    <th key={index}>
                      {header[index] || `Column ${index + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {Array.from({ length: columnCount }, (_, colIndex) => (
                      <td key={colIndex}>{row[colIndex] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export const PdfTabContent = ({
  filePath,
  title,
}: {
  filePath: string;
  title?: string;
}) => (
  <div className="display-sidebar__rich display-sidebar__rich--pdf">
    <PdfViewerCard filePath={filePath} {...(title ? { title } : {})} />
  </div>
);

export const ImageTabContent = ({
  filePaths,
  prompt,
  capability,
}: { filePaths: string[] } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "image", filePaths }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const VideoTabContent = ({
  filePath,
  prompt,
  capability,
}: { filePath: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "video", filePath }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const AudioTabContent = ({
  filePath,
  prompt,
  capability,
}: { filePath: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "audio", filePath }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const Model3dTabContent = ({
  filePath,
  label,
  prompt,
  capability,
}: { filePath: string; label?: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "model3d", filePath, ...(label ? { label } : {}) }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const DownloadTabContent = ({
  filePath,
  label,
  prompt,
  capability,
}: { filePath: string; label: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "download", filePath, label }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const TextTabContent = ({
  text,
  prompt,
  capability,
}: { text: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "text", text }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);
