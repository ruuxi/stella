import { describe, expect, it } from "vitest";
import { hasCompleteEmojiSpritePack } from "@/app/chat/emoji-sprites/active-emoji-pack";
import { getEmojiSpriteSheetCount } from "@/app/chat/emoji-sprites/sprite-map";

const sheetUrls = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `file:///emoji-${index}.webp`);

describe("emoji sprite packs", () => {
  it("requires every bundled sheet before replacing native chat emoji", () => {
    const required = getEmojiSpriteSheetCount();

    expect(hasCompleteEmojiSpritePack(null)).toBe(false);
    expect(
      hasCompleteEmojiSpritePack({
        packId: "partial",
        sheetUrls: sheetUrls(Math.max(0, required - 1)),
      }),
    ).toBe(false);
    expect(
      hasCompleteEmojiSpritePack({
        packId: "complete",
        sheetUrls: sheetUrls(required),
      }),
    ).toBe(true);
  });
});
