import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  ActivityContextChip,
  AppSelectionChips,
  FileContextChips,
  PastedTextChips,
  PendingCaptureChip,
  ScreenshotContextChips,
  SelectedTextChip,
  WindowContextChip,
} from "./ComposerContextChips";
import { getComposerAppSelections } from "@/features/chat/composer-context";
import "./composer-context.css";

type ComposerContextVariant = "full" | "compact";

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

/* The chip visuals live entirely in the shared components
 * (`ContextPill`, `ImageAttachmentChip`, `FileAttachmentChip`) so the
 * composer and the sent message row cannot drift apart. The variant maps
 * below only add layout constraints (the compact composer's tighter width
 * cap) plus the pending-capture shimmer's size classes. */
const captureVariantClassNames = {
  full: {
    containerClassName: null,
    pendingClassName:
      "chat-composer-context-chip chat-composer-context-chip--pending composer-context-chip composer-context-chip--pending",
    pendingInnerClassName:
      "chat-composer-context-pending-inner composer-context-pending-inner",
  },
  compact: {
    containerClassName: null,
    pendingClassName:
      "chat-composer-context-chip chat-composer-context-chip--pending compact-context-chip compact-context-chip--pending",
    pendingInnerClassName:
      "chat-composer-context-pending-inner compact-context-pending-inner",
  },
} as const;

const pillVariantClassNames = {
  full: {
    containerClassName: null,
    chipClassName: undefined,
  },
  compact: {
    containerClassName: null,
    chipClassName: "context-pill--compact",
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

  if (variant === "compact") {
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
  chatContext,
  setChatContext,
}: SharedContextProps) {
  const files = chatContext?.files ?? [];
  if (files.length === 0) return null;

  return <FileContextChips files={files} setChatContext={setChatContext} />;
}

export function ComposerPastedTextContextSection({
  variant,
  chatContext,
  setChatContext,
}: SharedContextProps) {
  const pastedTexts = chatContext?.pastedTexts ?? [];
  if (pastedTexts.length === 0) return null;

  const classes = pillVariantClassNames[variant];
  const content = (
    <PastedTextChips
      pastedTexts={pastedTexts}
      setChatContext={setChatContext}
      className={classes.chipClassName}
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
  const appSelections = getComposerAppSelections(chatContext);
  if (appSelections.length === 0) {
    return null;
  }

  const classes = pillVariantClassNames[variant];
  const content = (
    <AppSelectionChips
      appSelections={appSelections}
      setChatContext={setChatContext}
      className={classes.chipClassName}
    />
  );

  if (!classes.containerClassName) return content;
  return <div className={classes.containerClassName}>{content}</div>;
}

export function ComposerActivityContextSection({
  variant,
  chatContext,
  setChatContext,
}: SharedContextProps) {
  if (!chatContext?.activity) {
    return null;
  }

  const classes = pillVariantClassNames[variant];
  const content = (
    <ActivityContextChip
      activity={chatContext.activity}
      setChatContext={setChatContext}
      className={classes.chipClassName}
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

  const classes = pillVariantClassNames[variant];
  const content = (
    <SelectedTextChip
      selectedText={selectedText}
      setSelectedText={setSelectedText}
      setChatContext={setChatContext}
      className={classes.chipClassName}
    />
  );

  if (!classes.containerClassName) {
    return content;
  }

  return <div className={classes.containerClassName}>{content}</div>;
}
