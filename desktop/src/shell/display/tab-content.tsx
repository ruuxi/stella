/**
 * Per-kind viewer components used by the workspace panel's tab manager.
 *
 * Each component is a thin wrapper that delegates to the existing card UI
 * (MediaPreviewCard sub-renderers, OfficePreviewCard, PdfViewerCard). The
 * wrappers exist so the tab spec's `render()` function can be a single
 * `createElement(Component, props)` call — no per-call branching, no
 * `kind` discriminator inside the render path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Copy,
  Download,
  Folder,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { OfficePreviewRef } from "../../../../runtime/contracts/office-preview.js";
import { PdfViewerCard } from "@/app/chat/PdfViewerCard";
import { Markdown } from "@/app/chat/Markdown";
import { DropOverlay } from "@/app/chat/DropOverlay";
import {
  useDisplayFileBytes,
  useDisplayFileBlobs,
} from "@/shared/hooks/use-display-file-data";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import { copyImageBlob } from "@/shell/media-clipboard";
import { useFilePreviewActions } from "@/app/chat/hooks/use-file-preview-actions";
import { OfficeArtifactPanel } from "./office-artifact-panel";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { createServiceRequest } from "@/infra/http/service-request";
import {
  payloadToTabSpec,
  removeGeneratedMediaItem,
} from "./payload-to-tab-spec";
import { displayTabs } from "./tab-store";
import "./media-tab.css";

type WithMediaMeta = {
  prompt?: string;
  capability?: string;
};

type MediaTabItem = {
  id: string;
  asset: Extract<DisplayPayload, { kind: "media" }>["asset"];
  prompt?: string;
  capability?: string;
  createdAt: number;
};

type MediaActionId =
  | "text_to_image"
  | "image_edit"
  | "image_to_video"
  | "sound_effects"
  | "text_to_dialogue"
  | "text_to_3d";

type MediaAssetKind =
  | "image"
  | "video"
  | "audio"
  | "model3d"
  | "download"
  | "text";

type MediaAction = {
  id: MediaActionId;
  label: string;
  placeholder: string;
  sourceKind?: "image";
};

const MEDIA_ACTIONS: MediaAction[] = [
  {
    id: "text_to_image",
    label: "Photo",
    placeholder: "Describe a photo to make",
  },
  {
    id: "image_edit",
    label: "Edit",
    placeholder: "Describe how to change this image",
    sourceKind: "image",
  },
  {
    id: "image_to_video",
    label: "Animate",
    placeholder: "Describe how it should move",
    sourceKind: "image",
  },
  {
    id: "sound_effects",
    label: "Sound",
    placeholder: "Describe a sound effect",
  },
  {
    id: "text_to_dialogue",
    label: "Voice",
    placeholder: "Type what to say",
  },
  {
    id: "text_to_3d",
    label: "3D",
    placeholder: "Describe a 3D object",
  },
];

const readSourceAsDataUri = async (
  filePath: string,
): Promise<string | null> => {
  const result = await window.electronAPI?.display?.readFile?.(filePath);
  if (!result) return null;
  return `data:${result.mimeType};base64,${result.contentsBase64}`;
};

const SUPPORTED_MEDIA_MIME_PREFIXES = ["image/", "video/", "audio/"] as const;
const SUPPORTED_MEDIA_ACCEPT = "image/*,video/*,audio/*";

const isSupportedMediaMime = (type: string): boolean =>
  SUPPORTED_MEDIA_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));

const isSupportedMediaFile = (file: File): boolean =>
  isSupportedMediaMime(file.type);

const dataTransferHasSupportedMedia = (event: React.DragEvent): boolean => {
  const items = event.dataTransfer?.items;
  if (!items || items.length === 0) return false;
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    if (!item.type || isSupportedMediaMime(item.type)) return true;
  }
  return false;
};

const fileToDataUri = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });

const assetForImportedFile = (
  file: File,
  filePath: string,
): Extract<DisplayPayload, { kind: "media" }>["asset"] | null => {
  if (file.type.startsWith("image/")) {
    return { kind: "image", filePaths: [filePath] };
  }
  if (file.type.startsWith("video/")) {
    return { kind: "video", filePath };
  }
  if (file.type.startsWith("audio/")) {
    return { kind: "audio", filePath };
  }
  return null;
};

const importLocalMedia = async (file: File): Promise<void> => {
  const saveApi = window.electronAPI?.media?.saveOutput;
  if (!saveApi) throw new Error("Media import is not available");
  const dataUri = await fileToDataUri(file);
  const safeBase = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "import";
  const result = await saveApi(dataUri, `imported-${Date.now()}-${safeBase}`);
  if (!result.ok || !result.path) {
    throw new Error(result.error ?? "Could not save imported file");
  }
  const asset = assetForImportedFile(file, result.path);
  if (!asset) throw new Error("Unsupported file type");
  const payload: DisplayPayload = {
    kind: "media",
    asset,
    capability: "imported",
    createdAt: Date.now(),
  };
  displayTabs.openTab(payloadToTabSpec(payload));
};

const submitMediaJob = async ({
  capability,
  prompt,
  source,
}: {
  capability: MediaActionId;
  prompt: string;
  source?: string;
}): Promise<void> => {
  const { endpoint, headers } = await createServiceRequest(
    "/api/media/v1/generate",
    {
      "Content-Type": "application/json",
    },
  );
  const input = capability === "sound_effects" ? { duration_seconds: 5 } : {};
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      capability,
      prompt,
      input,
      ...(source ? { source } : {}),
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Media request failed (${response.status})`);
  }
};

const glyphForMediaItem = (
  item: MediaTabItem,
): { glyph: string; badge?: string } => {
  switch (item.asset.kind) {
    case "image":
      return item.asset.filePaths.length > 1
        ? { glyph: "Photos", badge: String(item.asset.filePaths.length) }
        : { glyph: "Photo" };
    case "video":
      return { glyph: "Video" };
    case "audio":
      return { glyph: "Audio" };
    case "model3d":
      return { glyph: "3D" };
    case "download":
      return { glyph: "File" };
    case "text":
      return { glyph: "Text" };
  }
};

const MediaTile = ({
  item,
  active,
  onSelect,
  onOpen,
  onAttach,
}: {
  item: MediaTabItem;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onAttach: () => void;
}) => {
  const filePaths = useMemo(
    () => (item.asset.kind === "image" ? item.asset.filePaths.slice(0, 1) : []),
    [item],
  );
  const { files } = useDisplayFileBlobs(filePaths);
  const thumbUrl = files[0]?.url ?? null;
  const isPending =
    item.asset.kind === "image" && item.asset.filePaths.length === 0;
  const { glyph, badge } = glyphForMediaItem(item);

  return (
    <div
      role="button"
      tabIndex={0}
      className={[
        "media-tab__tile",
        active ? "media-tab__tile--active" : null,
        isPending ? "media-tab__tile--pending" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-label={glyph}
      aria-pressed={active}
    >
      {thumbUrl ? (
        <img className="media-tab__tile-img" src={thumbUrl} alt="" />
      ) : (
        <span className="media-tab__tile-glyph">{glyph}</span>
      )}
      {badge ? <span className="media-tab__tile-badge">{badge}</span> : null}
      <button
        type="button"
        className="media-tab__tile-attach"
        onClick={(event) => {
          event.stopPropagation();
          onAttach();
        }}
        aria-label="Use this media"
        title="Use this media"
      >
        <Plus size={12} strokeWidth={2.4} />
      </button>
    </div>
  );
};

const AttachedChip = ({
  item,
  onRemove,
}: {
  item: MediaTabItem;
  onRemove: () => void;
}) => {
  const filePaths = useMemo(
    () => (item.asset.kind === "image" ? item.asset.filePaths.slice(0, 1) : []),
    [item],
  );
  const { files } = useDisplayFileBlobs(filePaths);
  const thumbUrl = files[0]?.url ?? null;
  const { glyph } = glyphForMediaItem(item);

  return (
    <span className="media-tab__attached" role="group">
      <span className="media-tab__attached-clip">
        {thumbUrl ? (
          <img className="media-tab__attached-thumb" src={thumbUrl} alt="" />
        ) : (
          <span className="media-tab__attached-glyph">{glyph}</span>
        )}
      </span>
      <button
        type="button"
        className="media-tab__attached-x"
        onClick={onRemove}
        aria-label="Remove attached media"
        title="Remove"
      >
        <X size={11} strokeWidth={2.4} />
      </button>
    </span>
  );
};

const MediaActionBar = ({
  item,
  onDelete,
}: {
  item: MediaTabItem;
  onDelete: () => void;
}) => {
  const [message, setMessage] = useState<string | null>(null);
  const filePaths = useMemo(() => {
    switch (item.asset.kind) {
      case "image":
        return item.asset.filePaths.slice(0, 1);
      case "video":
      case "audio":
      case "model3d":
      case "download":
        return [item.asset.filePath];
      case "text":
        return [];
    }
  }, [item]);
  const { files } = useDisplayFileBlobs(filePaths);
  const blob = files[0] ?? null;
  const filePath = filePaths[0] ?? null;

  const handleSave = useCallback(async () => {
    if (!filePath) return;
    const result = await window.electronAPI?.system?.saveFileAs?.(
      filePath,
      filePath.split(/[\\/]/).pop() ?? filePath,
    );
    if (!result || result.canceled) return;
    setMessage(result.ok ? "Saved" : (result.error ?? "Could not save"));
  }, [filePath]);

  const handleCopy = useCallback(async () => {
    try {
      if (item.asset.kind === "image" && blob) {
        await copyImageBlob(blob.blob);
        setMessage("Copied");
        return;
      }
      if (item.asset.kind === "text") {
        await navigator.clipboard.writeText(item.asset.text);
        setMessage("Copied");
        return;
      }
      if (filePath) {
        await navigator.clipboard.writeText(filePath);
        setMessage("Copied");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not copy");
    }
  }, [blob, filePath, item]);

  const canSave = Boolean(filePath && window.electronAPI?.system?.saveFileAs);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    setConfirmDelete(false);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [item.id]);

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmDelete(false);
      }, 3000);
      return;
    }
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmDelete(false);
    onDelete();
  }, [confirmDelete, onDelete]);

  return (
    <div className="media-tab__actions" aria-label="Item actions">
      {canSave ? (
        <button
          type="button"
          className="media-tab__action-btn"
          onClick={handleSave}
          aria-label="Save"
          title="Save"
        >
          <Download size={14} strokeWidth={1.85} />
        </button>
      ) : null}
      <button
        type="button"
        className="media-tab__action-btn"
        onClick={handleCopy}
        aria-label="Copy"
        title="Copy"
      >
        <Copy size={14} strokeWidth={1.85} />
      </button>
      <button
        type="button"
        className={
          confirmDelete
            ? "media-tab__action-btn media-tab__action-btn--danger"
            : "media-tab__action-btn"
        }
        onClick={handleDelete}
        aria-label={confirmDelete ? "Click again to delete" : "Delete"}
        title={confirmDelete ? "Click again to delete" : "Delete"}
      >
        <Trash2 size={14} strokeWidth={1.85} />
      </button>
      {message ? (
        <span className="media-tab__action-status">{message}</span>
      ) : null}
    </div>
  );
};

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
              window.electronAPI?.system?.openExternal?.(url);
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

export const SourceDiffTabContent = ({
  filePath,
  title,
  patch,
}: {
  filePath: string;
  title?: string;
  patch?: string;
}) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    filePath,
    "Code preview requires the Stella desktop app.",
  );
  const fileText = useMemo(() => decodeTextBytes(bytes), [bytes]);
  const sections = useMemo(() => {
    if (patch?.trim()) {
      const parsed = parseApplyPatchPreview(patch);
      if (parsed.length > 0) return parsed;
    }
    if (!bytes) return [];
    return buildGeneratedFilePreview(filePath, fileText);
  }, [bytes, filePath, fileText, patch]);
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: filePath,
    copyText: patch?.trim() || fileText,
    suggestedName: title ?? filePath.split(/[\\/]/).pop() ?? "changes.diff",
  });

  return (
    <div className="display-sidebar__rich display-sidebar__rich--diff">
      <section className="display-file-preview display-file-preview--diff">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">Changes</span>
            <div className="display-file-preview__title" title={filePath}>
              {title ?? filePath.split(/[\\/]/).pop() ?? "Changes"}
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
          <div className="display-file-preview__empty">Loading...</div>
        ) : sections.length === 0 ? (
          <div className="display-file-preview__empty">No changes found.</div>
        ) : (
          <DiffRows sections={sections} />
        )}
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

export const MediaTabContent = ({
  items: incomingItems,
}: {
  items: MediaTabItem[];
}) => {
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const items = useMemo(
    () => incomingItems.filter((item) => !removedIds.has(item.id)),
    [incomingItems, removedIds],
  );

  const [selectedId, setSelectedId] = useState<string | null>(
    items.at(-1)?.id ?? null,
  );
  const [prompt, setPrompt] = useState("");
  const [actionId, setActionId] = useState<MediaActionId>("text_to_image");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachedItemId, setAttachedItemId] = useState<string | null>(null);
  const [draggingMedia, setDraggingMedia] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) {
      setSelectedId(items.at(-1)?.id ?? null);
    }
  }, [items, selectedId]);

  const selectedItem =
    items.find((item) => item.id === selectedId) ?? items.at(-1) ?? null;

  const handleDelete = useCallback(
    (id: string) => {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      removeGeneratedMediaItem(id);
      if (attachedItemId === id) setAttachedItemId(null);
    },
    [attachedItemId],
  );

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        await importLocalMedia(file);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not import file");
      }
    },
    [],
  );

  const importDroppedFiles = useCallback(async (files: File[]) => {
    const supported = files.filter(isSupportedMediaFile);
    if (supported.length === 0) {
      setError("Drop an image, video, or audio file.");
      return;
    }
    setError(null);
    try {
      for (const file of supported) {
        await importLocalMedia(file);
      }
      if (supported.length < files.length) {
        setError("Some files were skipped because they are not media.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import files");
    }
  }, []);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasSupportedMedia(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setDraggingMedia(true);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasSupportedMedia(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggingMedia) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setDraggingMedia(false);
      }
    },
    [draggingMedia],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setDraggingMedia(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      void importDroppedFiles(files);
    },
    [importDroppedFiles],
  );

  const attachedItem = items.find((item) => item.id === attachedItemId) ?? null;
  const attachedKind: MediaAssetKind | null = attachedItem?.asset.kind ?? null;

  const visibleActions = useMemo(
    () =>
      MEDIA_ACTIONS.filter(
        (action) =>
          !action.sourceKind ||
          (attachedKind != null && action.sourceKind === attachedKind),
      ),
    [attachedKind],
  );
  const activeAction =
    visibleActions.find((action) => action.id === actionId) ??
    visibleActions[0] ??
    MEDIA_ACTIONS[0];
  useEffect(() => {
    if (!visibleActions.some((action) => action.id === actionId)) {
      setActionId(visibleActions[0]?.id ?? "text_to_image");
    }
  }, [actionId, visibleActions]);

  const compatibleAttachedItem =
    attachedItem &&
    activeAction.sourceKind &&
    attachedItem.asset.kind === activeAction.sourceKind
      ? attachedItem
      : null;
  const compatibleImagePath =
    compatibleAttachedItem?.asset.kind === "image"
      ? compatibleAttachedItem.asset.filePaths[0]
      : null;

  const needsImageSource = activeAction.sourceKind === "image";
  const canSubmit =
    prompt.trim().length > 0 &&
    !submitting &&
    (!needsImageSource || Boolean(compatibleImagePath));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const source = compatibleImagePath
        ? await readSourceAsDataUri(compatibleImagePath)
        : null;
      await submitMediaJob({
        capability: activeAction.id,
        prompt: prompt.trim(),
        ...(source ? { source } : {}),
      });
      setPrompt("");
      if (attachedItemId) setAttachedItemId(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start media work",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const expandPanel = useCallback(() => {
    displayTabs.setPanelExpanded(true);
  }, []);

  return (
    <div
      className="media-tab"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropOverlay visible={draggingMedia} variant="sidebar" />
      <div className="media-tab__top">
        {selectedItem ? (
          <MediaActionBar
            item={selectedItem}
            onDelete={() => handleDelete(selectedItem.id)}
          />
        ) : null}
      </div>

      <div
        className="media-tab__hero"
        onClick={selectedItem ? expandPanel : undefined}
        role={selectedItem ? "button" : undefined}
        title={selectedItem ? "Expand panel" : undefined}
      >
        {selectedItem ? (
          <MediaPreviewCard
            asset={selectedItem.asset}
            inDialog
            {...(selectedItem.prompt ? { prompt: selectedItem.prompt } : {})}
            {...(selectedItem.capability
              ? { capability: selectedItem.capability }
              : {})}
          />
        ) : (
          <div className="media-tab__hero-empty">
            <div className="media-tab__hero-empty-title">Make something</div>
            <div className="media-tab__hero-empty-hint">
              Type what you'd like below.
            </div>
          </div>
        )}
      </div>

      <div className="media-tab__rail" aria-label="Generated media">
        <button
          type="button"
          className="media-tab__rail-import"
          onClick={handlePickFile}
          aria-label="Add a file from your computer"
          title="Add a file from your computer"
        >
          <Folder size={18} strokeWidth={1.85} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_MEDIA_ACCEPT}
          className="media-tab__file-input"
          onChange={handleFileChange}
        />
        {items.map((item) => (
          <MediaTile
            key={item.id}
            item={item}
            active={item.id === selectedItem?.id}
            onSelect={() => setSelectedId(item.id)}
            onAttach={() => setAttachedItemId(item.id)}
            onOpen={expandPanel}
          />
        ))}
      </div>

      {error ? <div className="media-tab__error">{error}</div> : null}

      <form className="media-tab__composer" onSubmit={onSubmit}>
        <div
          className="media-tab__modes"
          role="tablist"
          aria-label="Media modes"
        >
          {visibleActions.map((action) => {
            const attachedHere =
              attachedItem && attachedItem.asset.kind === action.sourceKind;
            const disabled = action.sourceKind === "image" && !attachedHere;
            return (
              <button
                key={action.id}
                type="button"
                role="tab"
                aria-selected={action.id === activeAction.id}
                className={
                  action.id === activeAction.id
                    ? "media-tab__mode media-tab__mode--active"
                    : "media-tab__mode"
                }
                disabled={disabled}
                onClick={() => setActionId(action.id)}
              >
                {action.label}
              </button>
            );
          })}
        </div>
        <div className="media-tab__composer-row">
          {compatibleAttachedItem ? (
            <AttachedChip
              item={compatibleAttachedItem}
              onRemove={() => setAttachedItemId(null)}
            />
          ) : null}
          <input
            type="text"
            className="media-tab__prompt-input"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder={activeAction.placeholder}
            aria-label={activeAction.placeholder}
          />
          <button
            type="submit"
            className="media-tab__prompt-submit"
            disabled={!canSubmit}
            aria-label={submitting ? "Starting" : "Make"}
          >
            <ArrowRight size={16} strokeWidth={2.4} />
          </button>
        </div>
      </form>
    </div>
  );
};

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
