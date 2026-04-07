import type { Dispatch, SetStateAction } from "react";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";
import { cn } from "@/shared/lib/utils";
import {
  clearComposerSelectedTextContext,
  clearComposerWindowContext,
  removeComposerFileContext,
  removeComposerScreenshotContext,
  toggleComposerWindowContext,
} from "./composer-context";

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

type WindowContextChipProps = {
  chatWindow: NonNullable<ChatContext["window"]>;
  included?: boolean;
  setChatContext: SetChatContext;
  className?: string;
  toggleClassName?: string;
  textClassName?: string;
  removeClassName?: string;
  textFormatter?: (chatWindow: NonNullable<ChatContext["window"]>) => string;
};

export function WindowContextChip({
  chatWindow,
  included = true,
  setChatContext,
  className,
  toggleClassName,
  textClassName,
  removeClassName,
  textFormatter,
}: WindowContextChipProps) {
  const label = textFormatter
    ? textFormatter(chatWindow)
    : `${chatWindow.app}${chatWindow.title ? ` - ${chatWindow.title}` : ""}`;
  const displayLabel = included ? label : `Include ${label}`;
  const showWindowHighlight = !included
    ? () => window.electronAPI?.overlay?.showWindowHighlight?.(chatWindow.bounds)
    : undefined;
  const hideWindowHighlight = () =>
    window.electronAPI?.overlay?.hideWindowHighlight?.();

  return (
    <div className={cn(className)} data-included={included ? "true" : "false"}>
      <button
        type="button"
        className={cn(toggleClassName)}
        aria-pressed={included}
        title={included ? "Window context included" : "Click to include window context"}
        onMouseEnter={showWindowHighlight}
        onMouseLeave={hideWindowHighlight}
        onClick={() => {
          hideWindowHighlight();
          toggleComposerWindowContext(setChatContext);
        }}
      >
        <span className={cn(textClassName)}>{displayLabel}</span>
      </button>
      <button
        type="button"
        className={cn(removeClassName)}
        aria-label="Remove window context"
        onClick={(event) => {
          event.stopPropagation();
          hideWindowHighlight();
          clearComposerWindowContext(setChatContext);
        }}
      >
        &times;
      </button>
    </div>
  );
}

type SelectedTextChipProps = {
  selectedText: string;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
  setChatContext: SetChatContext;
  className?: string;
  textClassName?: string;
  removeClassName?: string;
};

export function SelectedTextChip({
  selectedText,
  setSelectedText,
  setChatContext,
  className,
  textClassName,
  removeClassName,
}: SelectedTextChipProps) {
  return (
    <div className={cn(className)}>
      <span className={cn(textClassName)}>&quot;{selectedText}&quot;</span>
      <button
        type="button"
        className={cn(removeClassName)}
        aria-label="Remove selected text"
        onClick={(event) => {
          event.stopPropagation();
          clearComposerSelectedTextContext(setSelectedText, setChatContext);
        }}
      >
        &times;
      </button>
    </div>
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
  onPreviewScreenshot?: (index: number) => void;
  chipClassName?: string;
  imageClassName?: string;
  removeClassName?: string;
};

export function ScreenshotContextChips({
  screenshots,
  setChatContext,
  onPreviewScreenshot,
  chipClassName,
  imageClassName,
  removeClassName,
}: ScreenshotContextChipsProps) {
  return (
    <>
      {screenshots.map((screenshot, index) => (
        <div key={index} className={cn(chipClassName)}>
          <img
            src={screenshot.dataUrl}
            className={cn(imageClassName)}
            alt={`Screenshot ${index + 1}`}
            onClick={
              onPreviewScreenshot ? () => onPreviewScreenshot(index) : undefined
            }
          />
          <button
            type="button"
            className={cn(removeClassName)}
            aria-label="Remove screenshot"
            onClick={(event) => {
              event.stopPropagation();
              removeComposerScreenshotContext(index, setChatContext);
            }}
          >
            &times;
          </button>
        </div>
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

type FileContextChipsProps = {
  files: ChatContextFile[];
  setChatContext: SetChatContext;
  chipClassName?: string;
  removeClassName?: string;
};

export function FileContextChips({
  files,
  setChatContext,
  chipClassName,
  removeClassName,
}: FileContextChipsProps) {
  return (
    <>
      {files.map((file, index) => {
        const category = resolveFileCategory(file.mimeType, file.name);
        return (
          <div key={index} className={cn("chat-composer-file-chip", chipClassName)}>
            <div className="chat-composer-file-icon">
              <FileIcon category={category} />
            </div>
            <div className="chat-composer-file-info">
              <span className="chat-composer-file-name">{file.name}</span>
              <span className="chat-composer-file-size">{formatFileSize(file.size)}</span>
            </div>
            <button
              type="button"
              className={cn("chat-composer-context-remove", removeClassName)}
              aria-label={`Remove ${file.name}`}
              onClick={(event) => {
                event.stopPropagation();
                removeComposerFileContext(index, setChatContext);
              }}
            >
              &times;
            </button>
          </div>
        );
      })}
    </>
  );
}
