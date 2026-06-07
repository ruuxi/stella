import { describe, expect, it } from "vitest";
import type { ChatContext } from "../../../../runtime/contracts/index.js";
import { buildChatPromptMessages } from "../../../../runtime/kernel/chat-prompt-context.js";

const contextWindow = (app: string, title: string): ChatContext["window"] => ({
  app,
  title,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
});

describe("buildChatPromptMessages", () => {
  it("marks hidden active-window context as an internal message", () => {
    const result = buildChatPromptMessages({
      userPrompt: "Help with this",
      chatContext: {
        window: contextWindow("Cursor", "stella/runtime"),
      } satisfies ChatContext,
    });

    expect(result.visibleUserPrompt).toBe("Help with this");
    expect(result.promptMessages).toEqual([
      expect.objectContaining({
        uiVisibility: "hidden",
        messageType: "message",
      }),
    ]);
  });

  it("keeps active browser tab URLs in hidden context metadata", () => {
    const result = buildChatPromptMessages({
      userPrompt: "What is this?",
      chatContext: {
        window: contextWindow("Safari", "Context tools"),
        browserUrl: "https://example.com/context",
      } satisfies ChatContext,
    });

    expect(result.browserUrl).toBe("https://example.com/context");
    expect(result.promptMessages?.[0]?.text).toContain("<active-browser-tab");
    expect(result.promptMessages?.[0]?.text).toContain(
      "https://example.com/context",
    );
  });

  it("carries Stella area surface and anchor metadata in hidden context", () => {
    const result = buildChatPromptMessages({
      userPrompt: "Change this",
      chatContext: {
        window: null,
        appSelection: {
          label: "Workspace Actions",
          snapshot: "[button] Select area",
          bounds: { x: 10, y: 20, width: 120, height: 80 },
          surface: "stella-ui",
          anchor: {
            kind: "dom",
            tag: "section",
            role: "region",
            path: "main > aside[role=complementary] > section",
          },
        },
      } satisfies ChatContext,
    });

    const hidden = result.promptMessages?.[0]?.text ?? "";
    expect(hidden).toContain("<selected-stella-area");
    expect(hidden).toContain('surface="stella-ui"');
    expect(hidden).toContain('anchor-kind="dom"');
    expect(hidden).toContain('anchor-role="region"');
    expect(hidden).toContain("main &gt; aside[role=complementary]");
  });

  it("carries selected activity metadata in hidden context", () => {
    const result = buildChatPromptMessages({
      userPrompt: "What happened here?",
      chatContext: {
        window: null,
        activity: {
          id: "agent-123",
          label: "Fix composer chip",
          agentType: "general",
          status: "completed",
          runId: "run-456",
          anchorTurnId: "turn-789",
          startedAtMs: 1000,
          completedAtMs: 2000,
          lastUpdatedAtMs: 2000,
        },
      } satisfies ChatContext,
    });

    const hidden = result.promptMessages?.[0]?.text ?? "";
    expect(result.activityLabel).toBe("Fix composer chip");
    expect(hidden).toContain("<selected-activity");
    expect(hidden).toContain('id="agent-123"');
    expect(hidden).toContain('run-id="run-456"');
    expect(hidden).toContain('anchor-turn-id="turn-789"');
    expect(hidden).toContain('status="completed"');
  });

  it("includes active window accessibility text only in hidden context", () => {
    const result = buildChatPromptMessages({
      userPrompt: "What is selected?",
      chatContext: {
        window: contextWindow(
          "System Settings",
          "Screen & System Audio Recording",
        ),
        windowAxTree: [
          "<app_state>",
          "App=System Settings (pid 123)",
          'Window: "Screen & System Audio Recording", App: System Settings.',
          "1 window Screen & System Audio Recording",
          "\t2 checkbox Stella [selected]",
          "</app_state>",
        ].join("\n"),
      } satisfies ChatContext,
    });

    expect(result.visibleUserPrompt).toBe("What is selected?");
    const hidden = result.promptMessages?.[0]?.text ?? "";
    expect(hidden).toContain("<active-window");
    expect(hidden).toContain("<accessibility-tree>");
    expect(hidden).toContain("checkbox Stella [selected]");
    expect(result.visibleUserPrompt).not.toContain("checkbox Stella");
  });

  it("describes explicit images before the ambient window screenshot", () => {
    const result = buildChatPromptMessages({
      userPrompt: "What am I looking at?",
      explicitImageAttachmentCount: 2,
      chatContext: {
        window: contextWindow("Cursor", "stella/runtime"),
        windowScreenshot: {
          dataUrl: "data:image/png;base64,AAAA",
          width: 10,
          height: 10,
        },
      } satisfies ChatContext,
    });

    expect(result.promptMessages?.[0]?.text).toContain(
      "first 2 images are user-provided",
    );
    expect(result.promptMessages?.[0]?.text).toContain(
      "final image is a screenshot",
    );
  });
});
