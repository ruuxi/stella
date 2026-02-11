import { describe, expect, it } from "vitest";
import {
  createTwitchEmoteRemarkPlugin,
  transformTextWithEmotes,
} from "./remark-twitch-emotes";

const lookup = new Map<string, string>([
  ["\u2639", "https://cdn.example/emote/feelsbadman.webp"],
  ["\u2728", "https://cdn.example/emote/pog.webp"],
  ["\u2764", "https://cdn.example/emote/peepolove.webp"],
]);

const fallbackLookup = new Map<string, string>([
  ["\u2728", "https://cdn.example/emote/bigpog.webp"],
  ["\u2764", "https://cdn.example/emote/nymnlove.webp"],
]);

describe("transformTextWithEmotes", () => {
  it("keeps direct emote tokens as plain text", () => {
    const nodes = transformTextWithEmotes("OMEGALUL", lookup);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual({ type: "text", value: "OMEGALUL" });
  });

  it("preserves punctuation around mapped emoji", () => {
    const nodes = transformTextWithEmotes("Nice \u2728!", lookup);
    expect(nodes).toEqual([
      { type: "text", value: "Nice" },
      { type: "text", value: " " },
      {
        type: "image",
        alt: "",
        url: "https://cdn.example/emote/pog.webp#stella-emote",
      },
      { type: "text", value: "!" },
    ]);
  });

  it("leaves unknown tokens untouched", () => {
    const nodes = transformTextWithEmotes("hello world", lookup);
    expect(nodes).toEqual([
      { type: "text", value: "hello" },
      { type: "text", value: " " },
      { type: "text", value: "world" },
    ]);
  });

  it("maps unicode emoji to available emote urls", () => {
    const nodes = transformTextWithEmotes("\u2639\uFE0F \u2728", lookup);
    expect(nodes).toEqual([
      {
        type: "image",
        alt: "",
        url: "https://cdn.example/emote/feelsbadman.webp#stella-emote",
      },
      { type: "text", value: " " },
      {
        type: "image",
        alt: "",
        url: "https://cdn.example/emote/pog.webp#stella-emote",
      },
    ]);
  });

  it("maps hearts using variation selector fallback", () => {
    const nodes = transformTextWithEmotes("\u2764\uFE0F", lookup);
    expect(nodes).toEqual([
      {
        type: "image",
        alt: "",
        url: "https://cdn.example/emote/peepolove.webp#stella-emote",
      },
    ]);
  });

  it("uses exact emoji lookup values", () => {
    const nodes = transformTextWithEmotes("\u2764\uFE0F \u2728", fallbackLookup);
    expect(nodes).toEqual([
      {
        type: "image",
        alt: "",
        url: "https://cdn.example/emote/nymnlove.webp#stella-emote",
      },
      { type: "text", value: " " },
      {
        type: "image",
        alt: "",
        url: "https://cdn.example/emote/bigpog.webp#stella-emote",
      },
    ]);
  });
});

describe("createTwitchEmoteRemarkPlugin", () => {
  it("does not replace text inside inline code blocks", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "\u2639\uFE0F " },
            { type: "inlineCode", value: "\u2639\uFE0F" },
          ],
        },
      ],
    };

    const plugin = createTwitchEmoteRemarkPlugin(lookup);
    plugin()(tree);

    const paragraph = tree.children[0];
    expect(paragraph.children).toEqual([
      {
        type: "image",
        alt: "",
        url: "https://cdn.example/emote/feelsbadman.webp#stella-emote",
      },
      { type: "text", value: " " },
      { type: "inlineCode", value: "\u2639\uFE0F" },
    ]);
  });
});
