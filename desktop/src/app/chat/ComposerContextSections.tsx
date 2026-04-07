import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  FileContextChips,
  PendingCaptureChip,
  ScreenshotContextChips,
  SelectedTextChip,
  WindowContextChip,
} from "./ComposerContextChips";
import "./composer-context.css";

type ComposerContextVariant = "full" | "mini";

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;
type SetSelectedText = Dispatch<SetStateAction<string | null>>;

type SharedContextProps = {
  variant: ComposerContextVariant;
  chatContext: ChatContext | null;
  setChatContext: SetChatContext;
};

type CaptureContextSectionProps = SharedContextProps & {
  onPreviewScreenshot?: (index: number) => void;
};

type SelectedTextContextSectionProps = {
  variant: ComposerContextVariant;
  selectedText: string | null;
  setSelectedText: SetSelectedText;
  setChatContext: SetChatContext;
};

const captureVariantClassNames = {
  full: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--screenshot composer-context-chip composer-context-chip--screenshot",
    imageClassName:
      "chat-composer-context-thumb composer-context-thumb",
    removeClassName:
      "chat-composer-context-remove composer-context-remove",
    pendingClassName:
      "chat-composer-context-chip chat-composer-context-chip--pending composer-context-chip composer-context-chip--pending",
    pendingInnerClassName:
      "chat-composer-context-pending-inner composer-context-pending-inner",
  },
  mini: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--screenshot mini-context-chip mini-context-chip--screenshot",
    imageClassName:
      "chat-composer-context-thumb mini-context-thumb",
    removeClassName:
      "chat-composer-context-remove mini-context-remove",
    pendingClassName:
      "chat-composer-context-chip chat-composer-context-chip--pending mini-context-chip mini-context-chip--pending",
    pendingInnerClassName:
      "chat-composer-context-pending-inner mini-context-pending-inner",
  },
} as const;

const fileVariantClassNames = {
  full: {
    containerClassName: null,
    chipClassName: "composer-context-chip",
    removeClassName: "chat-composer-context-remove composer-context-remove",
  },
  mini: {
    containerClassName: null,
    chipClassName: "mini-context-chip",
    removeClassName: "chat-composer-context-remove mini-context-remove",
  },
} as const;

const selectedTextVariantClassNames = {
  full: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--text composer-context-chip composer-context-chip--text",
    textClassName:
      "chat-composer-context-text composer-context-text",
    removeClassName:
      "chat-composer-context-remove composer-context-remove",
  },
  mini: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--text mini-context-chip mini-context-chip--text",
    textClassName:
      "chat-composer-context-text mini-context-text",
    removeClassName:
      "chat-composer-context-remove mini-context-remove",
  },
} as const;

export function ComposerWindowContextSection({
  variant,
  chatContext,
  setChatContext,
}: SharedContextProps) {
  if (!chatContext?.window) {
    return null;
  }

  if (variant === "mini") {
    return (
      <WindowContextChip
        chatWindow={chatContext.window}
        included={chatContext.windowContextEnabled !== false}
        setChatContext={setChatContext}
        className="chat-composer-context-chip chat-composer-context-chip--window composer-context-chip composer-context-chip--window"
        toggleClassName="composer-context-window-toggle"
        textClassName="chat-composer-context-window composer-context-window"
        removeClassName="chat-composer-context-remove composer-context-remove"
        textFormatter={(chatWindow) => chatWindow.title || chatWindow.app}
      />
    );
  }

  return (
    <WindowContextChip
      chatWindow={chatContext.window}
      included={chatContext.windowContextEnabled !== false}
      setChatContext={setChatContext}
      className="chat-composer-context-chip chat-composer-context-chip--window composer-context-chip composer-context-chip--window"
      toggleClassName="composer-context-window-toggle"
      textClassName="chat-composer-context-window composer-context-window"
      removeClassName="chat-composer-context-remove composer-context-remove"
    />
  );
}

export function ComposerCaptureContextSection({
  variant,
  chatContext,
  setChatContext,
  onPreviewScreenshot,
}: CaptureContextSectionProps) {
  const screenshots = chatContext?.regionScreenshots ?? [];
  const hasScreenshots = screenshots.length > 0;
  const isCapturePending = Boolean(chatContext?.capturePending);

  if (!hasScreenshots && !isCapturePending) {
    return null;
  }

  const classes = captureVariantClassNames[variant];
  const content = (
    <>
      {hasScreenshots ? (
        <ScreenshotContextChips
          screenshots={screenshots}
          setChatContext={setChatContext}
          onPreviewScreenshot={onPreviewScreenshot}
          chipClassName={classes.chipClassName}
          imageClassName={classes.imageClassName}
          removeClassName={classes.removeClassName}
        />
      ) : null}
      {isCapturePending ? (
        <PendingCaptureChip
          className={classes.pendingClassName}
          innerClassName={classes.pendingInnerClassName}
        />
      ) : null}
    </>
  );

  if (!classes.containerClassName) {
    return content;
  }

  return <div className={classes.containerClassName}>{content}</div>;
}

export function ComposerFileContextSection({
  variant,
  chatContext,
  setChatContext,
}: SharedContextProps) {
  const files = chatContext?.files ?? [];
  if (files.length === 0) return null;

  const classes = fileVariantClassNames[variant];
  const content = (
    <FileContextChips
      files={files}
      setChatContext={setChatContext}
      chipClassName={classes.chipClassName}
      removeClassName={classes.removeClassName}
    />
  );

  if (!classes.containerClassName) return content;
  return <div className={classes.containerClassName}>{content}</div>;
}

export function ComposerSelectedTextContextSection({
  variant,
  selectedText,
  setSelectedText,
  setChatContext,
}: SelectedTextContextSectionProps) {
  if (!selectedText) {
    return null;
  }

  const classes = selectedTextVariantClassNames[variant];
  const content = (
    <SelectedTextChip
      selectedText={selectedText}
      setSelectedText={setSelectedText}
      setChatContext={setChatContext}
      className={classes.chipClassName}
      textClassName={classes.textClassName}
      removeClassName={classes.removeClassName}
    />
  );

  if (!classes.containerClassName) {
    return content;
  }

  return <div className={classes.containerClassName}>{content}</div>;
}
