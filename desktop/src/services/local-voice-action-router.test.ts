import { describe, expect, it } from "vitest";
import { detectVoiceReflexAction, toSearchResults } from "./local-voice-action-router";

describe("local voice action router", () => {
  it("detects dashboard open reflexes", () => {
    expect(detectVoiceReflexAction("open the dashboard")).toEqual({
      action: "open_dashboard",
      spokenResult: "Your dashboard is open.",
    });
  });

  it("detects dashboard close reflexes", () => {
    expect(detectVoiceReflexAction("hide the overlay")).toEqual({
      action: "close_dashboard",
      spokenResult: "Okay, I hid the dashboard.",
    });
  });

  it("detects window listing reflexes", () => {
    expect(detectVoiceReflexAction("what windows are open")).toEqual({
      action: "manage_window",
      operation: "list",
    });
  });

  it("detects window focus reflexes", () => {
    expect(detectVoiceReflexAction("switch to weather")).toEqual({
      action: "manage_window",
      operation: "focus",
      windowType: "weather",
      spokenResult: "Okay, I focused Weather.",
    });
  });

  it("detects explicit web search reflexes", () => {
    expect(detectVoiceReflexAction("look up best noise cancelling headphones")).toEqual({
      action: "search_web",
      query: "best noise cancelling headphones",
      spokenResult: "I found a few results and put them on your dashboard.",
    });
  });

  it("normalizes search payload results", () => {
    expect(
      toSearchResults({
        results: [
          {
            title: "Example result",
            url: "https://example.com",
            content: "Useful context here",
          },
          {
            title: "Missing url",
          },
        ],
      }),
    ).toEqual([
      {
        title: "Example result",
        url: "https://example.com",
        snippet: "Useful context here",
      },
    ]);
  });
});
