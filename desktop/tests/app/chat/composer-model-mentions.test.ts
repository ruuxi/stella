import { describe, expect, it } from "vitest";
import {
  applyComposerModelMention,
  COMPOSER_ENGINE_MENTION_OPTIONS,
  filterComposerModelMentionOptions,
  findComposerModelMentionTrigger,
  resolveCurrentModelMentionValue,
} from "@/app/chat/ComposerModelMentionMenu";
import {
  findDelegatedModelMentions,
  normalizeDelegatedModelMention,
} from "../../../../runtime/contracts/model-mentions.js";

describe("composer engine mentions", () => {
  it("opens for an engine token at the caret and replaces the whole token", () => {
    const value = "Please ask @chat";
    const trigger = findComposerModelMentionTrigger(value, value.length);

    expect(trigger).toEqual({
      start: 11,
      end: 16,
      query: "chat",
    });
    expect(applyComposerModelMention(value, trigger!, "chatgpt")).toEqual({
      value: "Please ask @chatgpt ",
      caret: 20,
    });
  });

  it("can replace an existing engine token when the caret is in the middle", () => {
    const value = "@claude-code please review";
    const trigger = findComposerModelMentionTrigger(value, 7);

    expect(trigger).toEqual({
      start: 0,
      end: 12,
      query: "claude",
    });
    expect(applyComposerModelMention(value, trigger!, "claude-code")).toEqual({
      value: "@claude-code please review",
      caret: 12,
    });
  });

  it("does not trigger inside an email address", () => {
    const value = "rahul@example.com";
    expect(findComposerModelMentionTrigger(value, value.length)).toBeNull();
  });

  it("finds engine mentions without swallowing surrounding punctuation", () => {
    expect(
      findDelegatedModelMentions(
        "Ask (@chatgpt), then have @claude-code review it.",
      ),
    ).toEqual([
      {
        mention: "chatgpt",
        spawnModel: "codex",
        start: 5,
        end: 13,
      },
      {
        mention: "claude-code",
        spawnModel: "claude-code",
        start: 26,
        end: 38,
      },
    ]);
  });

  it("offers the engine destinations while supporting fuzzy aliases", () => {
    expect(
      COMPOSER_ENGINE_MENTION_OPTIONS.map((option) => option.value),
    ).toEqual(["stella", "chatgpt", "claude-code", "xai"]);
    expect(
      filterComposerModelMentionOptions(
        COMPOSER_ENGINE_MENTION_OPTIONS,
        "cld",
      )[0]?.value,
    ).toBe("claude-code");
    expect(
      filterComposerModelMentionOptions(
        COMPOSER_ENGINE_MENTION_OPTIONS,
        "codex",
      )[0]?.value,
    ).toBe("chatgpt");
  });

  it("orders the current engine before the recent engine when the query is empty", () => {
    const ranked = filterComposerModelMentionOptions(
      COMPOSER_ENGINE_MENTION_OPTIONS,
      "",
      {
        currentValue: "claude-code",
        recentValues: ["chatgpt"],
      },
    );

    expect(ranked.map((option) => option.value)).toEqual([
      "claude-code",
      "chatgpt",
      "stella",
      "xai",
    ]);
  });

  it("normalizes engine aliases but rejects pinned models and provider routes", () => {
    expect(normalizeDelegatedModelMention("stella")).toBe("stella");
    expect(normalizeDelegatedModelMention("xai")).toBe("xai/grok-4.5");
    expect(normalizeDelegatedModelMention("grok")).toBe("xai/grok-4.5");
    expect(normalizeDelegatedModelMention("chatgpt")).toBe("codex");
    expect(normalizeDelegatedModelMention("codex")).toBe("codex");
    expect(normalizeDelegatedModelMention("claude")).toBe("claude-code");
    expect(normalizeDelegatedModelMention("claude-code")).toBe("claude-code");
    expect(normalizeDelegatedModelMention("chatgpt/gpt-5.6-sol")).toBeNull();
    expect(normalizeDelegatedModelMention("claude-code/opus")).toBeNull();
    expect(
      normalizeDelegatedModelMention("anthropic/claude-opus-4.8"),
    ).toBeNull();
  });

  it("treats the default xAI route as the current xAI destination", () => {
    expect(
      resolveCurrentModelMentionValue({
        agentRuntimeEngine: "default",
        modelOverrides: { general: "xai/grok-4.5" },
      }),
    ).toBe("xai");
  });
});
