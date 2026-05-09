import type { Dispatch, SetStateAction } from "react";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";
import { cn } from "@/shared/lib/utils";
import { ChipPreviewPortal } from "./ChipPreviewPortal";
import { useHoverPreview } from "./use-hover-preview";
import {
  clearComposerAppSelectionContext,
  clearComposerSelectedTextContext,
  clearComposerWindowContext,
  removeComposerFileContext,
  removeComposerScreenshotContext,
  truncateChipLabel,
} from "./composer-context";

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
  const displayText = truncateChipLabel(selectedText);
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
  return (
    <button
      type="button"
      className={cn(className)}
      title={`${label} — click to remove selected area`}
      onClick={(event) => {
        clearComposerAppSelectionContext(setChatContext);
        event.currentTarget.blur();
      }}
    >
      <span className={cn(textClassName)}>{truncateChipLabel(label)}</span>
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
  const shared = {
    width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.75,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (category) {
    case "pdf":
      return (<svg {...shared}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 15v-1h6v1" /><path d="M12 12v6" /></svg>);
    case "document":
      return (<svg {...shared}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /><path d="M10 9H8" /></svg>);
    case "spreadsheet":
      return (<svg {...shared}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M8 13h2" /><path d="M14 13h2" /><path d="M8 17h2" /><path d="M14 17h2" /></svg>);
    case "code":
      return (<svg {...shared}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>);
    case "archive":
      return (<svg {...shared}><path d="M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3" /><path d="M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" /><rect x="2" y="8" width="20" height="8" rx="1" /><path d="M12 10v4" /></svg>);
    case "audio":
      return (<svg {...shared}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>);
    case "video":
      return (<svg {...shared}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m10 9 5 3-5 3V9Z" /></svg>);
    default:
      return (<svg {...shared}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>);
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
