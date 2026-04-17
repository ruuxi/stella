import path from "node:path";
import os from "node:os";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { extractAttachImageBlocks } from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

const createTempDir = () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-attach-image-"));
  tempDirs.push(tempDir);
  return tempDir;
};

// 1x1 transparent PNG (smallest valid PNG bytes).
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

const writePng = (dir: string, name = "snap.png") => {
  const outPath = path.join(dir, name);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, ONE_BY_ONE_PNG);
  return outPath;
};

describe("extractAttachImageBlocks (stella-computer auto-read)", () => {
  it("returns the original text untouched when no marker is present", async () => {
    const text = "no markers here\nplain output\n";
    const result = await extractAttachImageBlocks(text);
    expect(result.text).toBe(text);
    expect(result.images).toEqual([]);
  });

  it("extracts a single PNG referenced by a [stella-attach-image] marker", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);

    const text = `<stella_computer_state>
App=com.apple.finder (pid 504)
@d1 menu bar
</stella_computer_state>
[stella-attach-image] 1x1 1KB inline=image/png ${imgPath}
`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    // Marker should be stripped from forwarded text.
    expect(result.text).not.toContain("[stella-attach-image]");
    expect(result.text).toContain("App=com.apple.finder");
  });

  it("falls back to the raw text when the referenced file is missing", async () => {
    const text =
      "<stella_computer_state>...</stella_computer_state>\n" +
      "[stella-attach-image] 1x1 1KB inline=image/png /tmp/does-not-exist-zzzz.png\n";
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("[stella-attach-image]");
  });

  it("ignores markers that don't point at an image file", async () => {
    const text =
      "[stella-attach-image] 1x1 1KB inline=image/png /tmp/notes.txt\n";
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toBe(text);
  });

  it("infers MIME type from path extension", async () => {
    const tempDir = createTempDir();
    const jpgPath = writePng(tempDir, "snap.jpg");
    const text = `[stella-attach-image] 100x100 inline=image/jpeg ${jpgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/jpeg");
  });
});
