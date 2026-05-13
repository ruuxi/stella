/**
 * Per-kind viewer components used by the workspace panel's tab manager.
 *
 * Each component is a thin wrapper that delegates to the existing card UI
 * (MediaPreviewCard sub-renderers, OfficePreviewCard, PdfViewerCard). The
 * wrappers exist so the tab spec's `render()` function can be a single
 * `createElement(Component, props)` call — no per-call branching, no
 * `kind` discriminator inside the render path.
 *
 * The Media tab is its own world (drag/drop, generation submission,
 * tile rail, etc.) and lives in `./media-tab/`.
 */

import { useEffect, useMemo, useState } from "react";
import type { OfficePreviewRef } from "../../../../runtime/contracts/office-preview.js";
import { PdfViewerCard } from "@/app/chat/PdfViewerCard";
import { Markdown } from "@/app/chat/Markdown";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import { openExternalUrl } from "@/platform/electron/open-external";
import { useFilePreviewActions } from "@/app/chat/hooks/use-file-preview-actions";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import {
  sourceDiffBatches,
  useSourceDiffBatches,
  type SourceDiffBatch,
} from "./source-diff-batches";
import { OfficeArtifactPanel } from "./office-artifact-panel";

type WithMediaMeta = {
  prompt?: string;
  capability?: string;
};

export { MediaTabContent } from "./media-tab";

/**
 * Live URL preview tab. Used by the social-session preview server: an
 * iframe pointed at the per-session Vite dev server. Includes a tiny
 * reload affordance so participants can force a refresh after the
 * session host edits files (Vite usually HMRs without it).
 */
export const UrlTabContent = ({
  url,
  title,
}: {
  url: string;
  title: string;
}) => {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="display-sidebar__rich display-sidebar__rich--url">
      <header className="display-file-preview__header">
        <div className="display-file-preview__title-group">
          <span className="display-file-preview__eyebrow">Live preview</span>
          <div className="display-file-preview__title" title={url}>
            {title}
          </div>
        </div>
        <div className="display-file-preview__actions">
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => {
              openExternalUrl(url);
            }}
          >
            Open in browser
          </button>
        </div>
      </header>
      <iframe
        key={reloadKey}
        src={url}
        title={title}
        className="display-url-iframe"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
        referrerPolicy="no-referrer"
      />
    </div>
  );
};

export { TrashTabContent } from "./TrashTabContent";

export const OfficeTabContent = ({
  previewRef,
}: {
  previewRef: OfficePreviewRef;
}) => (
  <div className="display-sidebar__rich">
    <OfficeArtifactPanel previewRef={previewRef} />
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
      <section className="display-artifact-panel">
        <div className="display-artifact-panel__body">
          <div className="display-artifact-status">
            <div
              className={
                error
                  ? "display-artifact-status__text"
                  : "display-artifact-status__text loading-shimmer-pure-text"
              }
              title={filePath}
            >
              {error || "Preparing preview..."}
            </div>
          </div>
        </div>
      </section>
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

const decodeTextBytes = (bytes: Uint8Array | null): string =>
  bytes ? textDecoder.decode(bytes) : "";

export const MarkdownTabContent = ({
  filePath,
  title,
}: {
  filePath: string;
  title?: string;
}) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    filePath,
    "Markdown preview requires the Stella desktop app.",
  );
  const markdown = useMemo(() => decodeTextBytes(bytes), [bytes]);
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: filePath,
    copyText: markdown,
    suggestedName: title ?? filePath.split(/[\\/]/).pop() ?? "document.md",
  });

  return (
    <div className="display-sidebar__rich display-sidebar__rich--markdown">
      <section className="display-file-preview display-file-preview--markdown">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">Markdown</span>
            <div className="display-file-preview__title" title={filePath}>
              {title ?? filePath.split(/[\\/]/).pop() ?? "Markdown"}
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
        <div className="display-markdown-viewer">
          {error ? (
            <div className="display-file-preview__error">{error}</div>
          ) : loading ? (
            <div className="display-file-preview__empty">Loading...</div>
          ) : markdown.trim().length === 0 ? (
            <div className="display-file-preview__empty">No content found.</div>
          ) : (
            <Markdown text={markdown} />
          )}
        </div>
      </section>
    </div>
  );
};

type DiffLine = {
  kind: "add" | "delete" | "context" | "meta";
  text: string;
};

type DiffSection = {
  title: string;
  lines: DiffLine[];
};

const parseApplyPatchPreview = (patch: string): DiffSection[] => {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  const ensure = (title: string) => {
    if (!current || current.title !== title) {
      current = { title, lines: [] };
      sections.push(current);
    }
    return current;
  };

  for (const rawLine of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine.startsWith("*** Add File: ")) {
      ensure(rawLine.slice("*** Add File: ".length));
      continue;
    }
    if (rawLine.startsWith("*** Update File: ")) {
      ensure(rawLine.slice("*** Update File: ".length));
      continue;
    }
    if (rawLine.startsWith("*** Delete File: ")) {
      ensure(rawLine.slice("*** Delete File: ".length));
      continue;
    }
    if (!current) continue;
    const section: DiffSection = current;
    if (rawLine.startsWith("@@") || rawLine.startsWith("*** Move to: ")) {
      section.lines.push({ kind: "meta", text: rawLine });
      continue;
    }
    if (rawLine.startsWith("+")) {
      section.lines.push({ kind: "add", text: rawLine.slice(1) });
      continue;
    }
    if (rawLine.startsWith("-")) {
      section.lines.push({ kind: "delete", text: rawLine.slice(1) });
      continue;
    }
    if (rawLine.startsWith(" ")) {
      section.lines.push({ kind: "context", text: rawLine.slice(1) });
    }
  }
  return sections.filter((section) => section.lines.length > 0);
};

const buildGeneratedFilePreview = (
  filePath: string,
  text: string,
): DiffSection[] => [
  {
    title: filePath,
    lines: text
      .split("\n")
      .map((line): DiffLine => ({ kind: "add", text: line })),
  },
];

const DiffRows = ({ sections }: { sections: DiffSection[] }) => (
  <div className="display-diff-viewer__files">
    {sections.map((section, sectionIndex) => (
      <section
        key={`${section.title}:${sectionIndex}`}
        className="display-diff-file"
      >
        <header className="display-diff-file__header" title={section.title}>
          {section.title}
        </header>
        <div className="display-diff-file__body">
          {section.lines.map((line, lineIndex) => (
            <div
              key={`${lineIndex}:${line.kind}:${line.text}`}
              className={`display-diff-line display-diff-line--${line.kind}`}
            >
              <span className="display-diff-line__marker">
                {line.kind === "add"
                  ? "+"
                  : line.kind === "delete"
                    ? "-"
                    : line.kind === "meta"
                      ? "@"
                      : " "}
              </span>
              <code>{line.text || " "}</code>
            </div>
          ))}
        </div>
      </section>
    ))}
  </div>
);

type SourceDiffPayload = Extract<DisplayPayload, { kind: "source-diff" }>;

/**
 * Block variant that has a `patch` body — no file IO required.
 * Splitting the patch / file paths avoids firing N redundant
 * `useDisplayFileBytes` reads for an N-file `apply_patch` batch where
 * the patch text already contains every section.
 */
const SourceDiffPatchBlock = ({ patch }: { patch: string }) => {
  const parsedPatchSections = useMemo(() => {
    const parsed = parseApplyPatchPreview(patch);
    return parsed.length > 0 ? parsed : null;
  }, [patch]);

  if (!parsedPatchSections)
    return (
      <div className="display-file-preview__empty">No changes found.</div>
    );
  return <DiffRows sections={parsedPatchSections} />;
};

/**
 * Block variant for tools that emit fileChanges without a unified
 * diff body (write/edit-style tools). Reads the current bytes and
 * renders them as added lines — matches the existing "generated file"
 * preview semantics.
 */
const SourceDiffFileBytesBlock = ({ filePath }: { filePath: string }) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    filePath,
    "Code preview requires the Stella desktop app.",
  );
  const fileText = useMemo(() => decodeTextBytes(bytes), [bytes]);
  const sections = useMemo(() => {
    if (!bytes) return [];
    return buildGeneratedFilePreview(filePath, fileText);
  }, [bytes, filePath, fileText]);

  if (error) return <div className="display-file-preview__error">{error}</div>;
  if (loading)
    return <div className="display-file-preview__empty">Loading...</div>;
  if (sections.length === 0)
    return (
      <div className="display-file-preview__empty">No changes found.</div>
    );
  return <DiffRows sections={sections} />;
};

const SourceDiffFileBlock = ({ payload }: { payload: SourceDiffPayload }) => {
  if (payload.patch && payload.patch.trim().length > 0) {
    return <SourceDiffPatchBlock patch={payload.patch} />;
  }
  return <SourceDiffFileBytesBlock filePath={payload.filePath} />;
};

const formatRelativeTime = (timestamp: number, now: number): string => {
  const delta = Math.max(0, now - timestamp);
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
};

const useNowTick = (intervalMs: number): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};

const SourceDiffBatchFooter = ({
  batches,
  activeBatchId,
  now,
}: {
  batches: ReadonlyArray<SourceDiffBatch>;
  activeBatchId: string | null;
  now: number;
}) => {
  if (batches.length <= 1) return null;
  return (
    <footer className="display-diff-batches-footer">
      {batches.map((batch) => {
        const isActive = batch.id === activeBatchId;
        const fileLabel =
          batch.payloads.length === 1
            ? "1 file"
            : `${batch.payloads.length} files`;
        const label = batch.label ?? fileLabel;
        return (
          <button
            key={batch.id}
            type="button"
            className={`display-diff-batches-chip${
              isActive ? " display-diff-batches-chip--active" : ""
            }`}
            onClick={() => sourceDiffBatches.select(batch.id)}
            title={batch.payloads
              .filter(
                (entry): entry is SourceDiffPayload =>
                  entry.kind === "source-diff",
              )
              .map((entry) => entry.filePath)
              .join("\n")}
          >
            <span className="display-diff-batches-chip__label">{label}</span>
            <span className="display-diff-batches-chip__time">
              {formatRelativeTime(batch.createdAt, now)}
            </span>
          </button>
        );
      })}
    </footer>
  );
};

export const SourceDiffTabContent = () => {
  const { batches, activeBatchId } = useSourceDiffBatches();
  const now = useNowTick(30_000);

  const activeBatch = useMemo(() => {
    if (batches.length === 0) return null;
    const byId = batches.find((entry) => entry.id === activeBatchId);
    return byId ?? batches[0]!;
  }, [batches, activeBatchId]);

  const headerLabel = activeBatch
    ? activeBatch.payloads.length === 1
      ? activeBatch.payloads[0]!.kind === "source-diff"
        ? (activeBatch.payloads[0] as SourceDiffPayload).filePath
            .split(/[\\/]/)
            .pop() ?? "Changes"
        : "Changes"
      : `${activeBatch.payloads.length} files changed`
    : "Code changes";

  return (
    <div className="display-sidebar__rich display-sidebar__rich--diff">
      <section className="display-file-preview display-file-preview--diff">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">Changes</span>
            <div className="display-file-preview__title" title={headerLabel}>
              {headerLabel}
            </div>
          </div>
        </header>
        <div className="display-diff-batches-body">
          {!activeBatch ? (
            <div className="display-file-preview__empty">
              No file changes yet. When an agent edits code, the changes
              appear here.
            </div>
          ) : (
            <div className="display-diff-batches-body__scroll">
              {activeBatch.payloads
                .filter(
                  (payload): payload is SourceDiffPayload =>
                    payload.kind === "source-diff",
                )
                .map((payload) => (
                  <SourceDiffFileBlock
                    key={payload.filePath}
                    payload={payload}
                  />
                ))}
            </div>
          )}
        </div>
        <SourceDiffBatchFooter
          batches={batches}
          activeBatchId={activeBatchId}
          now={now}
        />
      </section>
    </div>
  );
};

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
