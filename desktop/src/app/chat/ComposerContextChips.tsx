import {
  useState,
  type Dispatch,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";
import { cn } from "@/shared/lib/utils";
import {
  AppWindowMac,
  Archive,
  ClipboardList,
  ClipboardPaste,
  Code,
  Crop,
  File,
  FileSpreadsheet,
  FileText,
  Music,
  TextQuote,
  Video,
  X,
} from "@/ui/icons";
import { ChipPreviewPortal } from "./ChipPreviewPortal";
import { useHoverPreview } from "./use-hover-preview";
import { ImageLightbox } from "@/ui/image-lightbox";
import { getElectronApi } from "@/platform/electron/electron";
import {
  describePastedText,
  PASTED_TEXT_PREVIEW_MAX_CHARS,
  toPastedTextDescriptor,
} from "@/features/chat/lib/paste-context";
import {
  clearComposerActivityContext,
  clearComposerAppSelectionContext,
  clearComposerSelectedTextContext,
  clearComposerWindowContext,
  removeComposerFileContext,
  removeComposerPastedTextContext,
  removeComposerScreenshotContext,
  truncateChipLabel,
} from "@/features/chat/composer-context";
import "./composer-context.css";

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

/* ------------------------------------------------------------------ */
/*  Shared chip affordances                                           */
/* ------------------------------------------------------------------ */

/**
 * Small × pinned to the chip's top-right corner. Removal is deliberately
 * separated from the chip body — the body is the preview click target —
 * so the handlers stop propagation to keep the two from triggering each
 * other. Subtle until the chip is hovered or focused (CSS), but always
 * reachable via Tab.
 */
function ChipRemoveButton({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="composer-chip-remove"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove();
      }}
    >
      <X size={10} strokeWidth={2.25} />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Canonical context pill                                            */
/* ------------------------------------------------------------------ */

export type ContextPillKind =
  | "window"
  | "app-selection"
  | "activity"
  | "pasted-text"
  | "selected-text";

const CONTEXT_PILL_ICONS = {
  window: AppWindowMac,
  "app-selection": Crop,
  activity: ClipboardList,
  "pasted-text": ClipboardPaste,
  "selected-text": TextQuote,
} as const;

type ContextPillProps = HTMLAttributes<HTMLElement> & {
  kind: ContextPillKind;
  label: ReactNode;
  /** Render as a button when the pill body is itself a click/hover target. */
  as?: "span" | "button";
  pillRef?: Ref<HTMLElement>;
  "data-has-preview"?: string;
};

/**
 * Canonical attached-context pill: leading type glyph + label with the
 * primary-tinted treatment. The single source of chip visuals for BOTH
 * the composer (pre-send) and the sent user message row, so the two
 * surfaces cannot drift apart. Wrappers add surface behavior: the
 * composer contributes the × remove control and hover previews; the
 * sent row contributes hovercards and the "+N" overflow.
 */
export function ContextPill({
  kind,
  label,
  as = "span",
  pillRef,
  className,
  children,
  ...rest
}: ContextPillProps) {
  const Icon = CONTEXT_PILL_ICONS[kind];
  const body = (
    <>
      <Icon
        className="context-pill__icon"
        size={13}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="context-pill__label">{label}</span>
      {children}
    </>
  );
  const pillClassName = cn("context-pill", `context-pill--${kind}`, className);
  if (as === "button") {
    return (
      <button
        type="button"
        ref={pillRef as Ref<HTMLButtonElement>}
        className={pillClassName}
        {...rest}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      ref={pillRef as Ref<HTMLSpanElement>}
      className={pillClassName}
      {...rest}
    >
      {body}
    </span>
  );
}

type WindowContextChipProps = {
  chatWindow: NonNullable<ChatContext["window"]>;
  chatWindowScreenshot?: ChatContext["windowScreenshot"];
  /**
   * When true, the chip is showing eagerly-attached metadata while the
   * screenshot capture is still in flight. Renders a subtle pulse so the
   * user knows we're working on it.
   */
  capturePending?: boolean;
  setChatContext: SetChatContext;
  className?: string;
  toggleClassName?: string;
  textClassName?: string;
  textFormatter?: (chatWindow: NonNullable<ChatContext["window"]>) => string;
};

export function WindowContextChip({
  chatWindow,
  chatWindowScreenshot,
  capturePending = false,
  setChatContext,
  className,
  toggleClassName,
  textClassName,
  textFormatter,
}: WindowContextChipProps) {
  const baseLabel = textFormatter
    ? textFormatter(chatWindow)
    : `${chatWindow.app}${chatWindow.title ? ` - ${chatWindow.title}` : ""}`;
  const displayLabel = truncateChipLabel(baseLabel);
  const hasScreenshot = Boolean(chatWindowScreenshot?.dataUrl);
  const { triggerRef, open } = useHoverPreview<HTMLDivElement>();
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div
      ref={triggerRef}
      className={cn("composer-chip-shell", hasScreenshot && className)}
      data-included="true"
      data-capture-pending={capturePending ? "true" : undefined}
      data-with-thumb={hasScreenshot ? "true" : undefined}
    >
      {hasScreenshot ? (
        <button
          type="button"
          className={cn(
            toggleClassName,
            "chat-composer-context-window-card composer-chip-previewable",
          )}
          title={
            capturePending
              ? `${baseLabel} — capturing window…`
              : `${baseLabel} — click to enlarge`
          }
          onClick={() => {
            setPreviewOpen(true);
          }}
        >
          <img
            src={chatWindowScreenshot!.dataUrl}
            alt=""
            className="chat-composer-context-window-thumb"
          />
          <span className={cn(textClassName)}>{displayLabel}</span>
        </button>
      ) : (
        <ContextPill
          as="button"
          kind="window"
          label={displayLabel}
          title={
            capturePending ? `${baseLabel} — capturing window…` : baseLabel
          }
        />
      )}
      <ChipRemoveButton
        label={`Remove ${chatWindow.app} window context`}
        onRemove={() => clearComposerWindowContext(setChatContext)}
      />
      {hasScreenshot && (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open && !previewOpen}
          className="composer-context-preview composer-context-preview--portal"
        >
          <img
            src={chatWindowScreenshot!.dataUrl}
            alt="Window content preview"
            className="composer-context-preview-img"
          />
        </ChipPreviewPortal>
      )}
      {hasScreenshot && (
        <ImageLightbox
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          src={chatWindowScreenshot!.dataUrl}
          alt={`${baseLabel} window screenshot`}
        />
      )}
    </div>
  );
}

type SelectedTextChipProps = {
  selectedText: string;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
  setChatContext: SetChatContext;
  className?: string;
};

export function SelectedTextChip({
  selectedText,
  setSelectedText,
  setChatContext,
  className,
}: SelectedTextChipProps) {
  const displayText = truncateChipLabel(selectedText, 36);
  return (
    <span className="composer-chip-shell">
      <ContextPill
        as="button"
        kind="selected-text"
        label={<>&quot;{displayText}&quot;</>}
        title={`"${selectedText}"`}
        className={className}
      />
      <ChipRemoveButton
        label="Remove selected text"
        onRemove={() =>
          clearComposerSelectedTextContext(setSelectedText, setChatContext)
        }
      />
    </span>
  );
}

type AppSelectionChipProps = {
  appSelection: NonNullable<ChatContext["appSelection"]>;
  setChatContext: SetChatContext;
  className?: string;
};

export function AppSelectionChip({
  appSelection,
  setChatContext,
  className,
}: AppSelectionChipProps) {
  const label = appSelection.label || "Selected area";
  const source = appSelection.source;
  const sourceSuffix = source?.filePath
    ? `\n${source.componentName ? `${source.componentName} — ` : ""}${source.filePath}${
        typeof source.lineNumber === "number" ? `:${source.lineNumber}` : ""
      }`
    : "";
  return (
    <span className="composer-chip-shell">
      <ContextPill
        as="button"
        kind="app-selection"
        label={truncateChipLabel(label)}
        title={`${label}${sourceSuffix}`}
        className={className}
      />
      <ChipRemoveButton
        label="Remove selected area"
        onRemove={() => clearComposerAppSelectionContext(setChatContext)}
      />
    </span>
  );
}

type ActivityContextChipProps = {
  activity: NonNullable<ChatContext["activity"]>;
  setChatContext: SetChatContext;
  className?: string;
};

export function ActivityContextChip({
  activity,
  setChatContext,
  className,
}: ActivityContextChipProps) {
  const label = activity.label || "Activity";
  const displayLabel = truncateChipLabel(label, 28);
  return (
    <span className="composer-chip-shell">
      <ContextPill
        as="button"
        kind="activity"
        label={displayLabel}
        title={label}
        className={className}
      />
      <ChipRemoveButton
        label="Remove activity context"
        onRemove={() => clearComposerActivityContext(setChatContext)}
      />
    </span>
  );
}

type PendingCaptureChipProps = {
  className?: string;
  innerClassName?: string;
};

export function PendingCaptureChip({
  className,
  innerClassName,
}: PendingCaptureChipProps) {
  return (
    <div className={cn(className)}>
      <div className={cn(innerClassName)} />
    </div>
  );
}

type ScreenshotContextChipsProps = {
  screenshots: NonNullable<ChatContext["regionScreenshots"]>;
  setChatContext: SetChatContext;
  // Legacy overlay hook — the chip now opens the shared ImageLightbox
  // itself, but the param is retained so callers can still pass it
  // without a type error.
  onPreviewScreenshot?: (index: number) => void;
  chipClassName?: string;
  imageClassName?: string;
};

type ImageAttachmentChipProps = {
  thumbnailUrl: string;
  fullImageUrl: string;
  alt: string;
  title: string;
  chipClassName?: string;
  imageClassName?: string;
  removeLabel?: string;
  onRemove?: () => void;
};

/**
 * Canonical compact image-attachment chip used before and after send.
 * Owns its full class list — callers may add hooks via `chipClassName`
 * but the card/thumb geometry lives here so the composer and the sent
 * message row render identical thumbnails. Composer callers add removal;
 * sent-message callers keep the same visual body and lightbox behavior
 * without exposing a remove affordance.
 */
export function ImageAttachmentChip({
  thumbnailUrl,
  fullImageUrl,
  alt,
  title,
  chipClassName,
  imageClassName,
  removeLabel,
  onRemove,
}: ImageAttachmentChipProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <span className="composer-chip-shell">
      <button
        type="button"
        className={cn(
          "chat-composer-context-chip chat-composer-context-chip--screenshot composer-context-chip composer-context-chip--screenshot",
          "chat-composer-context-window-card chat-composer-context-region-card composer-chip-previewable",
          chipClassName,
        )}
        data-with-thumb="true"
        data-region-card="true"
        title={title}
        onClick={() => setPreviewOpen(true)}
      >
        <img
          src={thumbnailUrl}
          className={cn(
            "chat-composer-context-thumb composer-context-thumb chat-composer-context-window-thumb chat-composer-context-region-thumb",
            imageClassName,
          )}
          alt={alt}
        />
      </button>
      {onRemove && removeLabel ? (
        <ChipRemoveButton label={removeLabel} onRemove={onRemove} />
      ) : null}
      <ImageLightbox
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        src={fullImageUrl}
        alt={alt}
      />
    </span>
  );
}

export function ScreenshotContextChips({
  screenshots,
  setChatContext,
  chipClassName,
  imageClassName,
}: ScreenshotContextChipsProps) {
  return (
    <>
      {screenshots.map((screenshot, index) => (
        <ImageAttachmentChip
          key={index}
          thumbnailUrl={screenshot.previewUrl ?? screenshot.dataUrl}
          fullImageUrl={screenshot.dataUrl}
          alt={`Screenshot ${index + 1}`}
          title="Click to enlarge screenshot"
          chipClassName={chipClassName}
          imageClassName={imageClassName}
          removeLabel={`Remove screenshot ${index + 1}`}
          onRemove={() =>
            removeComposerScreenshotContext(index, setChatContext)
          }
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  File attachment chips                                             */
/* ------------------------------------------------------------------ */

function resolveFileCategory(
  mimeType: string,
  name: string,
): "pdf" | "document" | "spreadsheet" | "code" | "archive" | "audio" | "video" | "file" {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType.includes("zip") || mimeType.includes("tar") ||
    mimeType.includes("gzip") || mimeType.includes("rar") || mimeType.includes("7z")
  ) return "archive";
  if (
    mimeType.includes("spreadsheet") || mimeType.includes("csv") ||
    /\.(?:xlsx?|csv|tsv|ods)$/i.test(name)
  ) return "spreadsheet";
  if (
    mimeType.includes("document") || mimeType.includes("msword") ||
    mimeType.includes("text/plain") || mimeType.includes("text/markdown") ||
    mimeType.includes("rtf") || /\.(?:docx?|txt|md|rtf|odt|pages)$/i.test(name)
  ) return "document";
  if (
    mimeType.includes("javascript") || mimeType.includes("typescript") ||
    mimeType.includes("json") || mimeType.includes("xml") ||
    mimeType.includes("html") || mimeType.includes("css") ||
    mimeType.includes("python") || mimeType.includes("java") ||
    mimeType.includes("x-sh") ||
    /\.(?:js|jsx|ts|tsx|py|rb|rs|go|c|cpp|h|swift|kt|java|json|yaml|yml|toml|sh|bash|zsh|css|scss|html|xml|sql|lua|r|php)$/i.test(name)
  ) return "code";
  return "file";
}

function FileIcon({ category }: { category: ReturnType<typeof resolveFileCategory> }) {
  const shared = { size: 16, strokeWidth: 1.75 };
  switch (category) {
    case "pdf":
      return <FileText {...shared} />;
    case "document":
      return <FileText {...shared} />;
    case "spreadsheet":
      return <FileSpreadsheet {...shared} />;
    case "code":
      return <Code {...shared} />;
    case "archive":
      return <Archive {...shared} />;
    case "audio":
      return <Music {...shared} />;
    case "video":
      return <Video {...shared} />;
    default:
      return <File {...shared} />;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FILE_NAME_MAX_CHARS = 12;

// Truncate to FILE_NAME_MAX_CHARS but keep the extension visible when it
// fits — losing the extension drops a lot of context for short caps.
function truncateFileName(name: string, max: number = FILE_NAME_MAX_CHARS): string {
  if (name.length <= max) return name;
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0 && dotIdx >= name.length - 6) {
    const ext = name.slice(dotIdx);
    const stemBudget = max - ext.length - 1;
    if (stemBudget >= 1) {
      return `${name.slice(0, stemBudget)}…${ext}`;
    }
  }
  return `${name.slice(0, max)}…`;
}

const FILE_CATEGORY_LABELS: Record<
  ReturnType<typeof resolveFileCategory>,
  string
> = {
  pdf: "PDF",
  document: "Document",
  spreadsheet: "Spreadsheet",
  code: "Code file",
  archive: "Archive",
  audio: "Audio",
  video: "Video",
  file: "File",
};

/**
 * Human type label for a file attachment whose real filename is missing
 * (older persisted payloads). Never a generic "Attachment" string that a
 * narrow chip would clip into nonsense.
 */
export function fileAttachmentTypeLabel(mimeType?: string): string {
  return FILE_CATEGORY_LABELS[resolveFileCategory(mimeType ?? "", "")];
}

type FileAttachmentChipProps = {
  name: string;
  size?: number;
  mimeType?: string;
  /**
   * On-disk source path. When present the chip opens the original in its
   * default app — the same preview convention as the composer.
   */
  path?: string;
  chipClassName?: string;
  removeLabel?: string;
  onRemove?: () => void;
};

/**
 * Canonical document/file chip used before and after send: file-type
 * glyph, real filename (extension-preserving truncation), optional size.
 * Composer callers add removal; sent-message callers keep the same
 * visual body without a remove affordance.
 */
export function FileAttachmentChip({
  name,
  size,
  mimeType,
  path,
  chipClassName,
  removeLabel,
  onRemove,
}: FileAttachmentChipProps) {
  const category = resolveFileCategory(mimeType ?? "", name);
  // Disk-backed attachments open in their default app for preview;
  // synthetic files (no on-disk path) have no preview target.
  const canOpen = Boolean(path);
  return (
    <span className="composer-chip-shell">
      <button
        type="button"
        className={cn(
          "chat-composer-file-chip",
          chipClassName,
          canOpen && "composer-chip-previewable",
        )}
        title={canOpen ? `${name} — click to open` : name}
        onClick={
          canOpen
            ? () => {
                void getElectronApi()?.system?.openPath?.(path!);
              }
            : undefined
        }
      >
        <div className="chat-composer-file-icon">
          <FileIcon category={category} />
        </div>
        <div className="chat-composer-file-info">
          <span className="chat-composer-file-name">{truncateFileName(name)}</span>
          {typeof size === "number" && size > 0 ? (
            <span className="chat-composer-file-size">{formatFileSize(size)}</span>
          ) : null}
        </div>
      </button>
      {onRemove && removeLabel ? (
        <ChipRemoveButton label={removeLabel} onRemove={onRemove} />
      ) : null}
    </span>
  );
}

function FileContextChip({
  file,
  index,
  setChatContext,
  chipClassName,
}: {
  file: ChatContextFile;
  index: number;
  setChatContext: SetChatContext;
  chipClassName?: string;
}) {
  return (
    <FileAttachmentChip
      name={file.name}
      size={file.size}
      mimeType={file.mimeType}
      path={file.path}
      chipClassName={chipClassName}
      removeLabel={`Remove ${file.name}`}
      onRemove={() => removeComposerFileContext(index, setChatContext)}
    />
  );
}

type FileContextChipsProps = {
  files: ChatContextFile[];
  setChatContext: SetChatContext;
  chipClassName?: string;
};

export function FileContextChips({
  files,
  setChatContext,
  chipClassName,
}: FileContextChipsProps) {
  return (
    <>
      {files.map((file, index) => (
        <FileContextChip
          key={index}
          file={file}
          index={index}
          setChatContext={setChatContext}
          chipClassName={chipClassName}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Pasted-text chips                                                 */
/* ------------------------------------------------------------------ */

function PastedTextChip({
  text,
  index,
  setChatContext,
  className,
}: {
  text: string;
  index: number;
  setChatContext: SetChatContext;
  className?: string;
}) {
  const { triggerRef, open, previewProps } = useHoverPreview<HTMLButtonElement>();
  const stats = describePastedText(toPastedTextDescriptor(text));
  const preview =
    text.length > PASTED_TEXT_PREVIEW_MAX_CHARS
      ? `${text.slice(0, PASTED_TEXT_PREVIEW_MAX_CHARS)}…`
      : text;
  return (
    <span className="composer-chip-shell">
      <ContextPill
        as="button"
        kind="pasted-text"
        pillRef={triggerRef}
        label={`Pasted text · ${stats}`}
        title={`Pasted text — ${stats}`}
        className={className}
      />
      <ChipRemoveButton
        label="Remove pasted text"
        onRemove={() => removeComposerPastedTextContext(index, setChatContext)}
      />
      <ChipPreviewPortal
        triggerRef={triggerRef}
        open={open}
        className="composer-context-preview composer-context-preview--portal"
        {...previewProps}
      >
        <div className="composer-context-preview-text">{preview}</div>
      </ChipPreviewPortal>
    </span>
  );
}

type PastedTextChipsProps = {
  pastedTexts: string[];
  setChatContext: SetChatContext;
  className?: string;
};

export function PastedTextChips({
  pastedTexts,
  setChatContext,
  className,
}: PastedTextChipsProps) {
  return (
    <>
      {pastedTexts.map((text, index) => (
        <PastedTextChip
          key={index}
          text={text}
          index={index}
          setChatContext={setChatContext}
          className={className}
        />
      ))}
    </>
  );
}
