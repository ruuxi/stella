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

  it("carries every selected area when multiple selections are attached", () => {
    const result = buildChatPromptMessages({
      userPrompt: "Compare these",
      chatContext: {
        window: null,
        appSelections: [
          {
            label: "Sidebar",
            snapshot: "[nav] Sidebar entries",
            bounds: { x: 0, y: 0, width: 200, height: 600 },
            surface: "stella-ui",
          },
          {
            label: "Composer",
            snapshot: "[form] Composer body",
            bounds: { x: 200, y: 500, width: 600, height: 100 },
            surface: "stella-ui",
          },
        ],
      } satisfies ChatContext,
    });

    const hidden = result.promptMessages?.[0]?.text ?? "";
    const areaCount = hidden.split("<selected-stella-area").length - 1;
    expect(areaCount).toBe(2);
    expect(hidden).toContain('label="Sidebar"');
    expect(hidden).toContain('label="Composer"');
    expect(hidden).toContain("these 2 specific areas");
    expect(result.appSelectionLabel).toBe("Sidebar, Composer");
    expect(result.appSelectionLabels).toEqual(["Sidebar", "Composer"]);
  });

  it("still reads the legacy single appSelection slot", () => {
    const result = buildChatPromptMessages({
      userPrompt: "Change this",
      chatContext: {
        window: null,
        appSelection: {
          label: "Legacy area",
          snapshot: "[section] Legacy",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      } satisfies ChatContext,
    });

    const hidden = result.promptMessages?.[0]?.text ?? "";
    expect(hidden).toContain('label="Legacy area"');
    expect(result.appSelectionLabel).toBe("Legacy area");
    expect(result.appSelectionLabels).toEqual(["Legacy area"]);
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

  it("turns a ChatGPT composer mention into a short routing hint", () => {
    const result = buildChatPromptMessages({
      userPrompt: "@chatgpt Refactor this component",
    });

    expect(result.visibleUserPrompt).toBe("@chatgpt Refactor this component");
    const hidden = result.promptMessages?.[0]?.text ?? "";
    expect(hidden).toContain('<model-mention target="codex"');
    expect(hidden).toContain("The user wants codex for this request.");
  });

  it("routes engine aliases without treating model routes as mentions", () => {
    const stella = buildChatPromptMessages({
      userPrompt: "Please use @stella for this",
    });
    const xai = buildChatPromptMessages({
      userPrompt: "Please use @xai for this",
    });
    const codex = buildChatPromptMessages({
      userPrompt: "Please use @codex for this",
    });
    const claude = buildChatPromptMessages({
      userPrompt: "@claude fix the failing tests",
    });
    const pinnedChatGpt = buildChatPromptMessages({
      userPrompt: "Please use @chatgpt/gpt-5.6-sol for this",
    });
    const pinnedClaude = buildChatPromptMessages({
      userPrompt: "@claude-code/opus fix the failing tests",
    });
    const directModel = buildChatPromptMessages({
      userPrompt: "@anthropic/claude-opus-4.8 review this",
    });

    expect(stella.promptMessages?.[0]?.text).toContain('target="stella"');
    expect(xai.promptMessages?.[0]?.text).toContain('target="xai/grok-4.5"');
    expect(codex.promptMessages?.[0]?.text).toContain('target="codex"');
    expect(claude.promptMessages?.[0]?.text).toContain('target="claude-code"');
    expect(pinnedChatGpt.promptMessages).toBeUndefined();
    expect(pinnedClaude.promptMessages).toBeUndefined();
    expect(directModel.promptMessages).toBeUndefined();
  });

  it("routes an inline mention followed by sentence punctuation", () => {
    const result = buildChatPromptMessages({
      userPrompt: "Can you ask @chatgpt, then summarize the answer?",
    });

    expect(result.promptMessages?.[0]?.text).toContain(
      '<model-mention target="codex"',
    );
  });

  it("does not treat ordinary @mentions or email addresses as model routing", () => {
    const result = buildChatPromptMessages({
      userPrompt: "Ask @rahul or email rahul@example.com",
    });

    expect(result.promptMessages).toBeUndefined();
  });
});
