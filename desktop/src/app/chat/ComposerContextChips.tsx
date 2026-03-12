import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { cn } from "@/shared/lib/utils";
import {
  clearComposerSelectedTextContext,
  clearComposerWindowContext,
  removeComposerScreenshotContext,
} from "./composer-context";

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

type WindowContextChipProps = {
  chatWindow: NonNullable<ChatContext["window"]>;
  setChatContext: SetChatContext;
  className?: string;
  textClassName?: string;
  removeClassName?: string;
  textFormatter?: (chatWindow: NonNullable<ChatContext["window"]>) => string;
};

export function WindowContextChip({
  chatWindow,
  setChatContext,
  className,
  textClassName,
  removeClassName,
  textFormatter,
}: WindowContextChipProps) {
  const label = textFormatter
    ? textFormatter(chatWindow)
    : `${chatWindow.app}${chatWindow.title ? ` - ${chatWindow.title}` : ""}`;

  return (
    <div className={cn(className)}>
      <span className={cn(textClassName)}>{label}</span>
      <button
        type="button"
        className={cn(removeClassName)}
        aria-label="Remove window context"
        onClick={(event) => {
          event.stopPropagation();
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
