import type { ChatContext } from "../contracts/index.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../protocol/index.js";

type BuildChatPromptMessagesArgs = {
  userPrompt: string;
  selectedText?: string | null;
  chatContext?: ChatContext | null;
  explicitImageAttachmentCount?: number;
};

const buildWindowSnippet = (chatContext: ChatContext | null | undefined) => {
  if (!chatContext?.window || chatContext.windowContextEnabled === false)
    return "";

  return [chatContext.window.app, chatContext.window.title]
    .filter((part) => Boolean(part && part.trim()))
    .join(" - ");
};

const buildAppSelectionSnippet = (
  chatContext: ChatContext | null | undefined,
) => {
  const selection = chatContext?.appSelection;
  if (!selection?.snapshot?.trim()) return "";

  const label = selection.label?.trim() || "Selected area";
  return `<selected-stella-area label="${escapeXmlAttribute(label)}">\n${escapeXmlText(selection.snapshot.trim())}\n</selected-stella-area>`;
};

const escapeXmlAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const escapeXmlText = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const buildChatPromptMessages = ({
  userPrompt,
  selectedText,
  chatContext,
  explicitImageAttachmentCount = 0,
}: BuildChatPromptMessagesArgs): {
  visibleUserPrompt: string;
  windowContextLabel?: string;
  appSelectionLabel?: string;
  promptMessages?: RuntimePromptMessage[];
  windowScreenshotAttachment?: RuntimeAttachmentRef;
} => {
  const cleanedUserPrompt = userPrompt.trim();
  const selectedSnippet = selectedText?.trim() ?? "";
  const windowSnippet = buildWindowSnippet(chatContext);
  const appSelectionSnippet = buildAppSelectionSnippet(chatContext);
  const appSelectionLabel = chatContext?.appSelection?.label?.trim();
  const visibleParts: string[] = [];
  const hiddenContextParts: string[] = [];
  const windowScreenshotDataUrl = chatContext?.windowScreenshot?.dataUrl ?? "";
  const hasWindowScreenshot =
    chatContext?.windowContextEnabled !== false &&
    Boolean(windowScreenshotDataUrl);

  if (windowSnippet) {
    hiddenContextParts.push(
      `<active-window context="The user's currently focused window. May or may not be relevant to their request.">${windowSnippet}</active-window>`,
    );
  }

  if (appSelectionSnippet) {
    hiddenContextParts.push(
      `The user selected this specific area inside Stella. Treat it as the main referenced UI context when relevant.\n${appSelectionSnippet}`,
    );
  }

  if (selectedSnippet) {
    visibleParts.push(`"${selectedSnippet}"`);
  }

  if (cleanedUserPrompt) {
    visibleParts.push(cleanedUserPrompt);
  }

  const visibleUserPrompt = visibleParts.join("\n\n");
  const promptMessages: RuntimePromptMessage[] = [];

  if (hasWindowScreenshot) {
    if (explicitImageAttachmentCount > 0) {
      const attachmentOrdering =
        explicitImageAttachmentCount === 1
          ? "the first image is a user-provided screenshot or image included with this turn"
          : `the first ${explicitImageAttachmentCount} images are user-provided screenshots or images included with this turn`;
      hiddenContextParts.push(
        `Attached images, in order: ${attachmentOrdering}. The final image is a screenshot of the content area from the user's active window. Use the active-window image as ambient context, not as a separate user upload unless the request depends on it.`,
      );
    } else {
      hiddenContextParts.push(
        `The attached image is a screenshot of the content area from the user's active window. Use it to understand what the user is looking at.`,
      );
    }
  }

  if (hiddenContextParts.length > 0) {
    promptMessages.push({
      text: hiddenContextParts.join("\n\n"),
      uiVisibility: "hidden",
      messageType: "message",
      customType: "runtime.chat_context",
    });
  }

  let windowScreenshotAttachment: RuntimeAttachmentRef | undefined;
  if (hasWindowScreenshot) {
    windowScreenshotAttachment = {
      url: windowScreenshotDataUrl,
      mimeType: "image/png",
    };
  }

  return {
    visibleUserPrompt,
    ...(windowSnippet ? { windowContextLabel: windowSnippet } : {}),
    ...(appSelectionLabel ? { appSelectionLabel } : {}),
    ...(promptMessages.length > 0 ? { promptMessages } : {}),
    ...(windowScreenshotAttachment ? { windowScreenshotAttachment } : {}),
  };
};
