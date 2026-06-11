import { describe, expect, it } from "vitest";
import { stripStaleImageBlocks } from "../../../../../runtime/kernel/agent-runtime/thread-memory.js";

type TestMessage = {
  role: string;
  content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
};

const imageResult = (base64Bytes: number): TestMessage => ({
  role: "toolResult",
  content: [
    { type: "text", text: "viewed" },
    { type: "image", data: "a".repeat(base64Bytes), mimeType: "image/png" },
  ],
});

const countImages = (messages: TestMessage[]): number =>
  messages.reduce(
    (sum, message) =>
      sum + message.content.filter((block) => block.type === "image").length,
    0,
  );

describe("stripStaleImageBlocks retention budget", () => {
  it("keeps a multi-image reference set intact (the 12-ref regression)", async () => {
    // Old policy kept exactly 1 image: viewing 5 reference images left 4
    // as placeholders on the very next call. Pi-sized images (≤4.5MB
    // base64, typically ~300KB) must survive together.
    const messages = Array.from({ length: 6 }, () => imageResult(400 * 1024));
    const result = stripStaleImageBlocks(messages);
    expect(countImages(result)).toBe(6);
    expect(result).toBe(messages);
  });

  it("evicts oldest first past the image-count cap", () => {
    const messages = Array.from({ length: 10 }, () => imageResult(1024));
    const result = stripStaleImageBlocks(messages);
    expect(countImages(result)).toBe(8);
    // Oldest two are rewritten to text placeholders, newest kept.
    expect(result[0].content.some((b) => b.type === "image")).toBe(false);
    expect(result[1].content.some((b) => b.type === "image")).toBe(false);
    expect(
      result[0].content.find((b) => b.type === "text" && b.text?.includes("omitted")),
    ).toBeTruthy();
    expect(result[9].content.some((b) => b.type === "image")).toBe(true);
  });

  it("evicts oldest first past the byte budget", () => {
    // 4 x 4MB base64 = 16MB > 12MB budget: newest 3 fit, oldest evicted.
    const messages = Array.from({ length: 4 }, () => imageResult(4 * 1024 * 1024));
    const result = stripStaleImageBlocks(messages);
    expect(countImages(result)).toBe(3);
    expect(result[0].content.some((b) => b.type === "image")).toBe(false);
    expect(result[3].content.some((b) => b.type === "image")).toBe(true);
  });

  it("accounts per image block within a batched multi-image result", () => {
    const batched: TestMessage = {
      role: "toolResult",
      content: Array.from({ length: 10 }, () => ({
        type: "image",
        data: "a".repeat(1024),
        mimeType: "image/png",
      })),
    };
    const result = stripStaleImageBlocks([batched]);
    expect(countImages(result)).toBe(8);
    // Non-image structure preserved; evicted blocks become placeholders.
    expect(result[0].content).toHaveLength(10);
  });

  it("leaves non-tool messages untouched", () => {
    const messages: TestMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      imageResult(1024),
    ];
    const result = stripStaleImageBlocks(messages);
    expect(result).toBe(messages);
  });
});
