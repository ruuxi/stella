import { describe, expect, it } from "vitest";
import { extractEmojiToken, resolveEmojiToEmote } from "../../../../../src/app/chat/emotes/emoji-resolver";

const entries = [
  { code: "PogA", emoji: "✨", confidence: 0.7 },
  { code: "PogB", emoji: "✨", confidence: 0.9 },
  { code: "SadA", emoji: "😢", confidence: 0.8 },
];

describe("extractEmojiToken", () => {
  it("extracts first emoji from mixed text", () => {
    expect(extractEmojiToken("hello ✨ wow")).toBe("✨");
  });

  it("returns null when no emoji exists", () => {
    expect(extractEmojiToken("hello world")).toBeNull();
  });
});

describe("resolveEmojiToEmote", () => {
  it("matches exact emoji only", () => {
    const match = resolveEmojiToEmote("😢", entries);
    expect(match?.code).toBe("SadA");
    expect(match?.emoji).toBe("😢");
  });

  it("picks highest confidence by default", () => {
    const match = resolveEmojiToEmote("✨", entries);
    expect(match?.code).toBe("PogB");
    expect(match?.candidates).toBe(2);
  });

  it("uses seed for deterministic variation", () => {
    const a = resolveEmojiToEmote("✨", entries, { seed: "conv-1" });
    const b = resolveEmojiToEmote("✨", entries, { seed: "conv-1" });
    expect(a?.code).toBe(b?.code);
  });

  it("returns null for unknown emoji", () => {
    expect(resolveEmojiToEmote("🤖", entries)).toBeNull();
  });
});
