import { describe, expect, it } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { clearComposerWindowContext } from "@/app/chat/composer-context";
import { normalizeChatContext } from "@/shell/use-captured-chat-context";

const screenshot = (dataUrl: string) => ({
  dataUrl,
  width: 100,
  height: 80,
});

describe("composer context removal", () => {
  it("clears all window-scoped fields when a window or tab chip is removed", () => {
    let current: ChatContext | null = {
      window: {
        app: "Brave",
        title: "Example",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
      browserUrl: "https://example.com",
      selectedText: null,
      regionScreenshots: [screenshot("data:image/png;base64,kept")],
      windowScreenshot: screenshot("data:image/png;base64,removed"),
      capturePending: true,
      windowContextEnabled: true,
    };

    const setChatContext: Dispatch<SetStateAction<ChatContext | null>> = (
      value,
    ) => {
      current = typeof value === "function" ? value(current) : value;
    };

    clearComposerWindowContext(setChatContext);

    expect(current).toMatchObject({
      window: null,
      browserUrl: null,
      windowScreenshot: null,
      capturePending: false,
      windowContextEnabled: undefined,
      regionScreenshots: [screenshot("data:image/png;base64,kept")],
    });
  });

  it("drops orphaned window screenshots and browser URLs from stored context", () => {
    const normalized = normalizeChatContext({
      window: null,
      browserUrl: "https://example.com",
      selectedText: null,
      regionScreenshots: [],
      windowScreenshot: screenshot("data:image/png;base64,stale"),
      capturePending: true,
    });

    expect(normalized).toBeNull();
  });

  it("preserves unrelated attachments while stripping orphaned window context", () => {
    const normalized = normalizeChatContext({
      window: null,
      browserUrl: "https://example.com",
      selectedText: null,
      regionScreenshots: [screenshot("data:image/png;base64,region")],
      windowScreenshot: screenshot("data:image/png;base64,stale"),
      capturePending: true,
    });

    expect(normalized).toEqual({
      window: null,
      browserUrl: null,
      selectedText: null,
      regionScreenshots: [screenshot("data:image/png;base64,region")],
      windowScreenshot: null,
      capturePending: false,
      windowContextEnabled: undefined,
    });
  });
});
