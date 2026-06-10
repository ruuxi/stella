import type { Dispatch, SetStateAction } from "react";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";
import { cn } from "@/shared/lib/utils";
import {
  Archive,
  Code,
  File,
  FileSpreadsheet,
  FileText,
  Music,
  Video,
} from "@/ui/icons";
import { ChipPreviewPortal } from "./ChipPreviewPortal";
import { useHoverPreview } from "./use-hover-preview";
import {
  describePastedText,
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

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

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

  return (
    <div
      ref={triggerRef}
      className={cn(className)}
      data-included="true"
      data-capture-pending={capturePending ? "true" : undefined}
      data-with-thumb={hasScreenshot ? "true" : undefined}
    >
      <button
        type="button"
        className={cn(
          toggleClassName,
          hasScreenshot && "chat-composer-context-window-card",
        )}
        title={
          capturePending
            ? `${baseLabel} — capturing window… click to remove`
            : `${baseLabel} — click to remove`
        }
        onClick={(event) => {
          clearComposerWindowContext(setChatContext);
          event.currentTarget.blur();
        }}
      >
        {hasScreenshot && (
          <img
            src={chatWindowScreenshot!.dataUrl}
            alt=""
            className="chat-composer-context-window-thumb"
          />
        )}
        <span className={cn(textClassName)}>{displayLabel}</span>
      </button>
      {hasScreenshot && (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open}
          className="composer-context-preview composer-context-preview--portal"
        >
          <img
            src={chatWindowScreenshot!.dataUrl}
            alt="Window content preview"
            className="composer-context-preview-img"
          />
        </ChipPreviewPortal>
      )}
    </div>
  );
}

type SelectedTextChipProps = {
  selectedText: string;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
  setChatContext: SetChatContext;
  className?: string;
  textClassName?: string;
};

export function SelectedTextChip({
  selectedText,
  setSelectedText,
  setChatContext,
  className,
  textClassName,
}: SelectedTextChipProps) {
  const displayText = truncateChipLabel(selectedText, 36);
  return (
    <button
      type="button"
      className={cn(className)}
      title={`"${selectedText}" — click to remove selected text`}
      onClick={(event) => {
        clearComposerSelectedTextContext(setSelectedText, setChatContext);
        event.currentTarget.blur();
      }}
    >
      <span className={cn(textClassName)}>&quot;{displayText}&quot;</span>
    </button>
  );
}

type AppSelectionChipProps = {
  appSelection: NonNullable<ChatContext["appSelection"]>;
  setChatContext: SetChatContext;
  className?: string;
  textClassName?: string;
};

export function AppSelectionChip({
  appSelection,
  setChatContext,
  className,
  textClassName,
}: AppSelectionChipProps) {
  const label = appSelection.label || "Selected area";
  const source = appSelection.source;
  const sourceSuffix = source?.filePath
    ? `\n${source.componentName ? `${source.componentName} — ` : ""}${source.filePath}${
        typeof source.lineNumber === "number" ? `:${source.lineNumber}` : ""
      }`
    : "";
  return (
    <button
      type="button"
      className={cn(className)}
      title={`${label}${sourceSuffix}\n\nClick to remove selected area`}
      onClick={(event) => {
        clearComposerAppSelectionContext(setChatContext);
        event.currentTarget.blur();
      }}
    >
      <span className={cn(textClassName)}>{truncateChipLabel(label)}</span>
    </button>
  );
}

type ActivityContextChipProps = {
  activity: NonNullable<ChatContext["activity"]>;
  setChatContext: SetChatContext;
  className?: string;
  textClassName?: string;
};

export function ActivityContextChip({
  activity,
  setChatContext,
  className,
  textClassName,
}: ActivityContextChipProps) {
  const label = activity.label || "Activity";
  const displayLabel = truncateChipLabel(label, 28);
  return (
    <button
      type="button"
      className={cn(className)}
      title={`${label} — click to remove activity`}
      onClick={(event) => {
        clearComposerActivityContext(setChatContext);
        event.currentTarget.blur();
      }}
    >
      <span className={cn(textClassName)}>{displayLabel}</span>
    </button>
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
  // Preview previously opened the full-size view; with the
  // "click-to-remove" model the param is unused but retained so callers
  // can still pass it without a type error.
  onPreviewScreenshot?: (index: number) => void;
  chipClassName?: string;
  imageClassName?: string;
};

export function ScreenshotContextChips({
  screenshots,
  setChatContext,
  chipClassName,
  imageClassName,
}: ScreenshotContextChipsProps) {
  return (
    <>
      {screenshots.map((screenshot, index) => (
        <button
          type="button"
          key={index}
          className={cn(
            chipClassName,
            "chat-composer-context-window-card chat-composer-context-region-card",
          )}
          data-with-thumb="true"
          data-region-card="true"
          title="Click to remove screenshot"
          onClick={(event) => {
            removeComposerScreenshotContext(index, setChatContext);
            event.currentTarget.blur();
          }}
        >
          <img
            src={screenshot.dataUrl}
            className={cn(
              imageClassName,
              "chat-composer-context-window-thumb chat-composer-context-region-thumb",
            )}
            alt={`Screenshot ${index + 1}`}
          />
        </button>
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
      {files.map((file, index) => {
        const category = resolveFileCategory(file.mimeType, file.name);
        return (
          <button
            type="button"
            key={index}
            className={cn("chat-composer-file-chip", chipClassName)}
            title={`Click to remove ${file.name}`}
            onClick={(event) => {
              removeComposerFileContext(index, setChatContext);
              event.currentTarget.blur();
            }}
          >
            <div className="chat-composer-file-icon">
              <FileIcon category={category} />
            </div>
            <div className="chat-composer-file-info">
              <span className="chat-composer-file-name">{truncateFileName(file.name)}</span>
              <span className="chat-composer-file-size">{formatFileSize(file.size)}</span>
            </div>
          </button>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Pasted-text chips                                                 */
/* ------------------------------------------------------------------ */

// The preview is scrollable (the pointer can move onto it), so show a
// generous slice rather than a tooltip-sized one.
const PASTED_TEXT_PREVIEW_MAX_CHARS = 4000;

function PastedTextChip({
  text,
  index,
  setChatContext,
  className,
  textClassName,
}: {
  text: string;
  index: number;
  setChatContext: SetChatContext;
  className?: string;
  textClassName?: string;
}) {
  const { triggerRef, open, previewProps } = useHoverPreview<HTMLButtonElement>();
  const stats = describePastedText(toPastedTextDescriptor(text));
  const preview =
    text.length > PASTED_TEXT_PREVIEW_MAX_CHARS
      ? `${text.slice(0, PASTED_TEXT_PREVIEW_MAX_CHARS)}…`
      : text;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(className)}
        title={`Pasted text — ${stats} — click to remove`}
        onClick={(event) => {
          removeComposerPastedTextContext(index, setChatContext);
          event.currentTarget.blur();
        }}
      >
        <span className={cn(textClassName)}>{`Pasted text · ${stats}`}</span>
      </button>
      <ChipPreviewPortal
        triggerRef={triggerRef}
        open={open}
        className="composer-context-preview composer-context-preview--portal"
        {...previewProps}
      >
        <div className="composer-context-preview-text">{preview}</div>
      </ChipPreviewPortal>
    </>
  );
}

type PastedTextChipsProps = {
  pastedTexts: string[];
  setChatContext: SetChatContext;
  className?: string;
  textClassName?: string;
};

export function PastedTextChips({
  pastedTexts,
  setChatContext,
  className,
  textClassName,
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
          textClassName={textClassName}
        />
      ))}
    </>
  );
}
