import type { ChatContext } from "../contracts/index.js";
import type { RuntimeAttachmentRef, RuntimePromptMessage } from "../protocol/index.js";

type BuildChatPromptMessagesArgs = {
  userPrompt: string;
  selectedText?: string | null;
  chatContext?: ChatContext | null;
};

const buildWindowSnippet = (chatContext: ChatContext | null | undefined) => {
  if (!chatContext?.window || chatContext.windowContextEnabled === false) return "";

  return [chatContext.window.app, chatContext.window.title]
    .filter((part) => Boolean(part && part.trim()))
    .join(" - ");
};

export const buildChatPromptMessages = ({
  userPrompt,
  selectedText,
  chatContext,
}: BuildChatPromptMessagesArgs): {
  visibleUserPrompt: string;
  windowContextLabel?: string;
  promptMessages?: RuntimePromptMessage[];
  windowScreenshotAttachment?: RuntimeAttachmentRef;
} => {
  const cleanedUserPrompt = userPrompt.trim();
  const selectedSnippet = selectedText?.trim() ?? "";
  const windowSnippet = buildWindowSnippet(chatContext);
  const visibleParts: string[] = [];
  const hiddenContextParts: string[] = [];

  if (windowSnippet) {
    hiddenContextParts.push(
      `<active-window context="The user's currently focused window. May or may not be relevant to their request.">${windowSnippet}</active-window>`,
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

  if (
    chatContext?.windowContextEnabled !== false
    && chatContext?.windowScreenshot?.dataUrl
  ) {
    hiddenContextParts.push(
      `The attached image is a screenshot of the content area from the user's active window. Use it to understand what the user is looking at.`,
    );
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
  if (
    chatContext?.windowContextEnabled !== false
    && chatContext?.windowScreenshot?.dataUrl
  ) {
    windowScreenshotAttachment = {
      url: chatContext.windowScreenshot.dataUrl,
      mimeType: "image/png",
    };
  }

  return {
    visibleUserPrompt,
    ...(windowSnippet ? { windowContextLabel: windowSnippet } : {}),
    ...(promptMessages.length > 0 ? { promptMessages } : {}),
    ...(windowScreenshotAttachment ? { windowScreenshotAttachment } : {}),
  };
};
