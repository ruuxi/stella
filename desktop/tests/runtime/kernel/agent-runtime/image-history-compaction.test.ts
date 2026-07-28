import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createImageHistoryCompactor,
  estimateMessageSerializedBytes,
} from "../../../../../runtime/kernel/agent-runtime/image-history-compaction.js";

type TestBlock = {
  type: string;
  data?: string;
  mimeType?: string;
  text?: string;
};
type TestMessage = {
  role: string;
  content: TestBlock[] | string;
};

const imageResult = (base64Bytes: number, fill = "a"): TestMessage => ({
  role: "toolResult",
  content: [
    { type: "text", text: "viewed" },
    { type: "image", data: fill.repeat(base64Bytes), mimeType: "image/png" },
  ],
});

const countImages = (messages: TestMessage[]): number =>
  messages.reduce(
    (sum, message) =>
      sum +
      (Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "image").length
        : 0),
    0,
  );

const hasImage = (message: TestMessage): boolean =>
  Array.isArray(message.content) &&
  message.content.some((block) => block.type === "image");

const placeholderText = (message: TestMessage): string | undefined =>
  Array.isArray(message.content)
    ? message.content.find(
        (block) => block.type === "text" && block.text?.includes("removed"),
      )?.text
    : undefined;

const tmpDirs: string[] = [];
const makeTmpDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "stella-image-compaction-"),
  );
  tmpDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

describe("createImageHistoryCompactor", () => {
  it("returns the identical array while under the high watermark", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 100_000,
      lowWatermarkBytes: 60_000,
    });
    const messages = Array.from({ length: 4 }, () => imageResult(20_000));
    const result = await compactor.apply(messages);
    expect(result).toBe(messages);
    expect(countImages(result)).toBe(4);
  });

  it("strips oldest-first down to the low watermark on crossing", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 100_000,
      lowWatermarkBytes: 60_000,
      protectedTailMessages: 2,
    });
    const messages = Array.from({ length: 6 }, () => imageResult(20_000));
    const result = await compactor.apply(messages);
    // ~121KB estimated: stripping the 4 oldest lands under 60KB.
    expect(countImages(result)).toBe(2);
    for (const index of [0, 1, 2, 3]) {
      expect(hasImage(result[index]!)).toBe(false);
      expect(placeholderText(result[index]!)).toContain("image/png");
    }
    expect(hasImage(result[4]!)).toBe(true);
    expect(hasImage(result[5]!)).toBe(true);
    // Input untouched.
    expect(countImages(messages)).toBe(6);
  });

  it("is sticky between crossings: no new strips, byte-identical output", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 100_000,
      lowWatermarkBytes: 60_000,
      protectedTailMessages: 2,
    });
    const messages = Array.from({ length: 6 }, () => imageResult(20_000));
    const first = await compactor.apply(messages);
    const strippedAfterFirst = 6 - countImages(first);

    // Growth that stays under the high watermark: nothing new is stripped
    // and previously produced messages are byte-identical (prefix-stable).
    messages.push(imageResult(10_000));
    const second = await compactor.apply(messages);
    expect(6 + 1 - countImages(second)).toBe(strippedAfterFirst);
    for (let index = 0; index < first.length; index += 1) {
      expect(JSON.stringify(second[index])).toBe(JSON.stringify(first[index]));
    }
  });

  it("extends strips at the next crossing without disturbing earlier output", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 100_000,
      lowWatermarkBytes: 60_000,
      protectedTailMessages: 2,
    });
    const messages = Array.from({ length: 6 }, () => imageResult(20_000));
    const first = await compactor.apply(messages);
    const strippedAfterFirst = 6 - countImages(first);

    messages.push(imageResult(20_000), imageResult(20_000), imageResult(20_000));
    const second = await compactor.apply(messages);
    const strippedAfterSecond = messages.length - countImages(second);
    expect(strippedAfterSecond).toBeGreaterThan(strippedAfterFirst);
    // Everything stripped in round one is still stripped with identical text.
    for (let index = 0; index < strippedAfterFirst; index += 1) {
      expect(JSON.stringify(second[index])).toBe(JSON.stringify(first[index]));
    }
  });

  it("never strips images in the protected tail", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 50_000,
      lowWatermarkBytes: 20_000,
      protectedTailMessages: 2,
    });
    // Only tail messages carry images; over the watermark, but untouchable.
    const messages: TestMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      imageResult(40_000),
      imageResult(40_000),
    ];
    const result = await compactor.apply(messages);
    expect(result).toBe(messages);
    expect(countImages(result)).toBe(2);
  });

  it("strips user-message images too", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 50_000,
      lowWatermarkBytes: 20_000,
      protectedTailMessages: 1,
    });
    const messages: TestMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "b".repeat(60_000), mimeType: "image/jpeg" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    const result = await compactor.apply(messages);
    expect(countImages(result)).toBe(0);
    expect(placeholderText(result[0]!)).toContain("image/jpeg");
    // Surrounding text is preserved.
    expect(
      Array.isArray(result[0]!.content) &&
        result[0]!.content.some((block) => block.text === "look at this"),
    ).toBe(true);
  });

  it("accounts per image block within a batched multi-image result", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 100_000,
      lowWatermarkBytes: 60_000,
      protectedTailMessages: 0,
    });
    const batched: TestMessage = {
      role: "toolResult",
      content: Array.from({ length: 6 }, () => ({
        type: "image",
        data: "a".repeat(20_000),
        mimeType: "image/png",
      })),
    };
    const result = await compactor.apply([batched]);
    const blocks = result[0]!.content as TestBlock[];
    expect(blocks).toHaveLength(6);
    // Oldest blocks stripped, newest kept.
    expect(blocks.filter((block) => block.type === "image").length).toBeLessThan(
      6,
    );
    expect(blocks[blocks.length - 1]!.type).toBe("image");
    expect(blocks[0]!.type).toBe("text");
  });

  it("recomputes deterministically on a fresh compactor (restart safety)", async () => {
    const options = {
      highWatermarkBytes: 100_000,
      lowWatermarkBytes: 60_000,
      protectedTailMessages: 2,
    };
    const messages = Array.from({ length: 6 }, () => imageResult(20_000));
    const first = await createImageHistoryCompactor(options).apply(messages);
    const second = await createImageHistoryCompactor(options).apply(messages);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("spills stripped images to content-hashed files and points at them", async () => {
    const spillDirPath = await makeTmpDir();
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 50_000,
      lowWatermarkBytes: 20_000,
      protectedTailMessages: 1,
      spillDirPath,
    });
    const messages = [imageResult(60_000, "c"), imageResult(1_000)];
    const result = await compactor.apply(messages);
    const placeholder = placeholderText(result[0]!);
    expect(placeholder).toContain(spillDirPath);
    expect(placeholder).toContain("view_image");

    const files = await fs.readdir(spillDirPath);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^img-[0-9a-f]{16}\.png$/);
    const written = await fs.readFile(path.join(spillDirPath, files[0]!));
    expect(written.equals(Buffer.from("c".repeat(60_000), "base64"))).toBe(
      true,
    );

    // A fresh compactor (sticky memory lost) re-spills to the same file and
    // emits the same placeholder — no duplicates, no prefix churn.
    const again = await createImageHistoryCompactor({
      highWatermarkBytes: 50_000,
      lowWatermarkBytes: 20_000,
      protectedTailMessages: 1,
      spillDirPath,
    }).apply(messages);
    expect(placeholderText(again[0]!)).toBe(placeholder);
    expect(await fs.readdir(spillDirPath)).toHaveLength(1);
  });

  it("leaves string-content and image-free messages untouched", async () => {
    const compactor = createImageHistoryCompactor({
      highWatermarkBytes: 1_000,
      lowWatermarkBytes: 500,
      protectedTailMessages: 0,
    });
    const messages: TestMessage[] = [
      { role: "user", content: "plain string history entry ".repeat(100) },
      { role: "assistant", content: [{ type: "text", text: "x".repeat(2_000) }] },
    ];
    const result = await compactor.apply(messages);
    expect(result).toBe(messages);
  });
});

describe("estimateMessageSerializedBytes", () => {
  it("counts base64 image payloads at full weight", () => {
    const bytes = estimateMessageSerializedBytes(imageResult(50_000));
    expect(bytes).toBeGreaterThan(50_000);
    expect(bytes).toBeLessThan(51_000);
  });

  it("counts string content", () => {
    expect(
      estimateMessageSerializedBytes({ role: "user", content: "abc" }),
    ).toBeGreaterThan(3);
  });
});
