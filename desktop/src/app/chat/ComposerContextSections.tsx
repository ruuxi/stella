import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  AppSelectionChip,
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
  },
  mini: {
    containerClassName: null,
    chipClassName: "mini-context-chip",
  },
} as const;

const selectedTextVariantClassNames = {
  full: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--text composer-context-chip composer-context-chip--text",
    textClassName:
      "chat-composer-context-text composer-context-text",
  },
  mini: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--text mini-context-chip mini-context-chip--text",
    textClassName:
      "chat-composer-context-text mini-context-text",
  },
} as const;

const appSelectionVariantClassNames = {
  full: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--app-selection composer-context-chip composer-context-chip--app-selection",
    textClassName:
      "chat-composer-context-text composer-context-text",
  },
  mini: {
    containerClassName: null,
    chipClassName:
      "chat-composer-context-chip chat-composer-context-chip--app-selection mini-context-chip mini-context-chip--app-selection",
    textClassName:
      "chat-composer-context-text mini-context-text",
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

  const sharedProps = {
    chatWindow: chatContext.window,
    chatWindowScreenshot: chatContext.windowScreenshot,
    capturePending: chatContext.capturePending,
    setChatContext,
    className:
      "chat-composer-context-chip chat-composer-context-chip--window composer-context-chip composer-context-chip--window",
    toggleClassName: "composer-context-window-toggle",
    textClassName: "chat-composer-context-window composer-context-window",
    textFormatter: (chatWindow: NonNullable<ChatContext["window"]>) =>
      chatWindow.title
        ? `${chatWindow.app} — ${chatWindow.title}`
        : chatWindow.app,
  } as const;

  if (variant === "mini") {
    return <WindowContextChip {...sharedProps} />;
  }

  return <WindowContextChip {...sharedProps} />;
}

export function ComposerCaptureContextSection({
  variant,
  chatContext,
  setChatContext,
  onPreviewScreenshot,
}: CaptureContextSectionProps) {
  const screenshots = chatContext?.regionScreenshots ?? [];
  const hasScreenshots = screenshots.length > 0;
  // Only render the standalone pending-capture shimmer when there's no
  // window chip in flight — the window chip renders its own pending
  // treatment so users see one loading indicator, not two.
  const hasWindow = Boolean(chatContext?.window);
  const isCapturePending =
    Boolean(chatContext?.capturePending) && !hasWindow;

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
    />
  );

  if (!classes.containerClassName) return content;
  return <div className={classes.containerClassName}>{content}</div>;
}

export function ComposerAppSelectionContextSection({
  variant,
  chatContext,
  setChatContext,
}: SharedContextProps) {
  if (!chatContext?.appSelection) {
    return null;
  }

  const classes = appSelectionVariantClassNames[variant];
  const content = (
    <AppSelectionChip
      appSelection={chatContext.appSelection}
      setChatContext={setChatContext}
      className={classes.chipClassName}
      textClassName={classes.textClassName}
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
    />
  );

  if (!classes.containerClassName) {
    return content;
  }

  return <div className={classes.containerClassName}>{content}</div>;
}
