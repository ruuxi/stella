import { describe, expect, it } from "vitest";
import {
  applyComposerModelMention,
  filterComposerModelMentionOptions,
  findComposerModelMentionTrigger,
  type ComposerModelMentionOption,
} from "@/app/chat/ComposerModelMentionMenu";
import { findDelegatedModelMentions } from "../../../../runtime/contracts/model-mentions.js";

describe("composer model mentions", () => {
  it("opens for a model token at the caret and replaces the whole token", () => {
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

  it("can replace an existing token when the caret is in the middle", () => {
    const value = "@claude-code please review";
    const trigger = findComposerModelMentionTrigger(value, 7);

    expect(trigger).toEqual({
      start: 0,
      end: 12,
      query: "claude",
    });
    expect(
      applyComposerModelMention(value, trigger!, "claude-code/opus"),
    ).toEqual({
      value: "@claude-code/opus please review",
      caret: 17,
    });
  });

  it("does not trigger inside an email address", () => {
    const value = "rahul@example.com";
    expect(findComposerModelMentionTrigger(value, value.length)).toBeNull();
  });

  it("finds inline routing mentions without swallowing surrounding punctuation", () => {
    expect(
      findDelegatedModelMentions(
        "Ask (@chatgpt), then have @claude-code/opus review it.",
      ),
    ).toEqual([
      {
        mention: "chatgpt",
        spawnModel: "codex",
        start: 5,
        end: 13,
      },
      {
        mention: "claude-code/opus",
        spawnModel: "claude-code/opus",
        start: 26,
        end: 43,
      },
    ]);
  });

  it("filters by friendly engine name and exact model route", () => {
    const options: ComposerModelMentionOption[] = [
      {
        value: "chatgpt",
        label: "ChatGPT",
        description: "Use ChatGPT",
        brand: "openai",
        provider: "openai-codex",
        kind: "Engine",
        searchTerms: ["codex", "openai", "gpt"],
      },
      {
        value: "claude-code/opus",
        label: "Opus",
        description: "Claude Code · opus",
        brand: "anthropic",
        provider: "claude-code",
        kind: "Model",
        available: true,
      },
    ];

    expect(
      filterComposerModelMentionOptions(options, "chat").map(
        (option) => option.value,
      ),
    ).toEqual(["chatgpt"]);
    expect(
      filterComposerModelMentionOptions(options, "claude-code/op").map(
        (option) => option.value,
      ),
    ).toEqual(["claude-code/opus"]);
  });

  it("makes engine aliases win fuzzy Claude, Codex, and ChatGPT searches", () => {
    const options: ComposerModelMentionOption[] = [
      {
        value: "chatgpt",
        label: "ChatGPT",
        description: "Uses your selected model · gpt-5.6-sol",
        brand: "openai",
        provider: "openai-codex",
        kind: "Engine",
        searchTerms: ["codex", "openai", "gpt"],
      },
      {
        value: "claude-code",
        label: "Claude Code",
        description: "Uses your selected model · opus",
        brand: "anthropic",
        provider: "claude-code",
        kind: "Engine",
        searchTerms: ["claude", "anthropic", "opus"],
      },
      {
        value: "anthropic/claude-opus-4.8",
        label: "Claude Opus 4.8",
        description: "Anthropic · anthropic/claude-opus-4.8",
        brand: "anthropic",
        provider: "anthropic",
        kind: "Model",
      },
    ];

    expect(filterComposerModelMentionOptions(options, "claude")[0]?.value).toBe(
      "claude-code",
    );
    expect(filterComposerModelMentionOptions(options, "cld")[0]?.value).toBe(
      "claude-code",
    );
    expect(filterComposerModelMentionOptions(options, "codex")[0]?.value).toBe(
      "chatgpt",
    );
  });

  it("orders current, recent, and connected routes before the wider catalog", () => {
    const options: ComposerModelMentionOption[] = [
      {
        value: "chatgpt",
        label: "ChatGPT",
        description: "Uses your selected model",
        brand: "openai",
        provider: "openai-codex",
        kind: "Engine",
      },
      {
        value: "openrouter/x-ai/grok-4.5",
        label: "Grok 4.5",
        description: "OpenRouter",
        brand: "openrouter",
        provider: "openrouter",
        kind: "Model",
      },
      {
        value: "anthropic/claude-sonnet-4.6",
        label: "Claude Sonnet 4.6",
        description: "Anthropic",
        brand: "anthropic",
        provider: "anthropic",
        kind: "Model",
      },
      {
        value: "xai/grok-4.5",
        label: "Grok 4.5",
        description: "xAI",
        brand: "xai",
        provider: "xai",
        kind: "Model",
      },
    ];
    const ranked = filterComposerModelMentionOptions(options, "", {
      currentValue: "openrouter/x-ai/grok-4.5",
      recentValues: ["anthropic/claude-sonnet-4.6"],
      connectedProviders: new Set(["openrouter", "anthropic"]),
    });

    expect(ranked.slice(0, 2).map((option) => option.value)).toEqual([
      "openrouter/x-ai/grok-4.5",
      "anthropic/claude-sonnet-4.6",
    ]);
    expect(ranked.map((option) => option.value)).not.toContain("xai/grok-4.5");
    expect(ranked[0]?.badge).toBe("Current");
    expect(ranked[1]?.badge).toBe("Recent");
  });
});
