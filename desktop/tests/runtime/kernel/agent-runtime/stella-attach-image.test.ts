import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { extractAttachImageBlocks } from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const createTempDir = () => {
  return tempDirs.create("stella-attach-image-");
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

    const text = `<app_state>
App=com.apple.finder (pid 504)
0 menu bar
</app_state>
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
      "<app_state>...</app_state>\n" +
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

  it("extracts JSON-escaped Windows image paths", async () => {
    const tempDir = createTempDir();
    const previousCwd = process.cwd();
    const winPath = "C:\\Users\\test\\stella-snap.png";
    try {
      process.chdir(tempDir);
      writePng(tempDir, winPath);
      const text =
        "[stella-attach-image] 100x100 inline=image/png C:\\\\Users\\\\test\\\\stella-snap.png\n";
      const result = await extractAttachImageBlocks(text);
      expect(result.images).toHaveLength(1);
      expect(result.images[0].mimeType).toBe("image/png");
      expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
      expect(result.text).not.toContain("[stella-attach-image]");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("extracts a marker embedded inside a JSON-stringified tool result", async () => {
    // Mirrors the exec_command tool result shape: stdout is wrapped inside
    // a JSON envelope where real newlines become escaped `\n` characters.
    // Before the regex fix, the start-of-line anchor meant the marker was
    // never matched in this shape and the model had to call view_image
    // separately (which then failed for >2MB screenshots).
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);
    const payload = {
      session_id: null,
      running: false,
      exit_code: 0,
      output:
        "<app_state>\nApp=com.spotify.client (pid 465)\n0 standard window Spotify Premium\n14 menu bar\n</app_state>\n" +
        `[stella-attach-image] 2192x1688 507KB inline=image/png ${imgPath}\n`,
      cwd: "/Users/test/projects/stella",
      command: "stella-computer snapshot --app Spotify",
    };
    const text = JSON.stringify(payload, null, 2);
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    expect(result.text).not.toContain("[stella-attach-image]");
  });
});
