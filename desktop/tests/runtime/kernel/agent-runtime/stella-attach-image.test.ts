import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractAttachImageBlocks,
  truncateModelVisibleToolText,
} from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";
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

const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0xff, 0xd9,
]);

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

  it("uses image bytes over marker and extension when MIME types disagree", async () => {
    const tempDir = createTempDir();
    const imgPath = path.join(tempDir, "term-shot.png");
    writeFileSync(imgPath, JPEG_BYTES);

    const text = `[stella-attach-image] 2728x1872 43KB inline=image/png ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/jpeg");
    expect(result.images[0].data).toBe(JPEG_BYTES.toString("base64"));
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

  it("omits (rather than attaches) a file whose bytes are not a valid image", async () => {
    // Bytes that no image decoder can process (e.g. a corrupt/partial
    // capture). Attaching them raw would 400 Anthropic fatally and poison
    // the thread on every resume, so the marker is swapped for a note.
    const tempDir = createTempDir();
    const jpgPath = path.join(tempDir, "snap.jpg");
    writeFileSync(jpgPath, Buffer.from("not-enough-image-bytes"));
    const text = `[stella-attach-image] 100x100 inline=image/jpeg ${jpgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("could not be decoded");
    expect(result.text).not.toContain("[stella-attach-image]");
  });

  it("omits a truncated PNG whose header parses but stream is incomplete", async () => {
    // The exact reproduction shape: valid PNG signature + IHDR, but the
    // stream is cut off before IEND (a screenshot read mid-write).
    const tempDir = createTempDir();
    const imgPath = path.join(tempDir, "truncated.png");
    writeFileSync(imgPath, ONE_BY_ONE_PNG.subarray(0, ONE_BY_ONE_PNG.length - 16));
    const text = `[stella-attach-image] 1x1 inline=image/png ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("could not be decoded");
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

  it("auto-resizes oversized images and notes the coordinate mapping (pi parity)", async () => {
    // Pi-style attach behavior: a too-large image is resized to fit the
    // vision budget instead of being bounced back with a "go downscale it
    // yourself" note, and the model gets a dimension note for coordinate
    // mapping. Generate a real >2000px noise PNG via Photon so the resize
    // path actually exercises decode → resize → encode.
    const photon = await import("@silvia-odwyer/photon-node");
    const size = 2400;
    const raw = new Uint8Array(size * size * 4);
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = (i * 31) % 256;
      raw[i + 1] = (i * 17) % 256;
      raw[i + 2] = (i * 7) % 256;
      raw[i + 3] = 255;
    }
    const bigImage = new photon.PhotonImage(raw, size, size);
    const bigPngBytes = Buffer.from(bigImage.get_bytes());
    bigImage.free();

    const tempDir = createTempDir();
    const bigPath = path.join(tempDir, "huge.png");
    writeFileSync(bigPath, bigPngBytes);
    const smallPath = writePng(tempDir, "small.png");

    const text =
      `[stella-attach-image] inline=image/png ${bigPath}\n` +
      `[stella-attach-image] inline=image/png ${smallPath}\n`;
    const result = await extractAttachImageBlocks(text);

    // Both images attach: the big one resized, the small one untouched.
    expect(result.images).toHaveLength(2);
    expect(result.images[0].data.length).toBeLessThan(
      bigPngBytes.toString("base64").length,
    );
    expect(result.images[1].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    // Dimension note for the resized image only; markers stripped.
    expect(result.text).toContain(`original ${size}x${size}`);
    expect(result.text).toContain("Multiply coordinates by");
    expect(result.text).not.toContain("[stella-attach-image]");
  });

  it("passes small images through byte-identical (no resize, no note)", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);
    const text = `[stella-attach-image] 1x1 1KB inline=image/png ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    expect(result.text).not.toContain("Multiply coordinates by");
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

describe("truncateModelVisibleToolText", () => {
  it("leaves small tool output unchanged", () => {
    const result = truncateModelVisibleToolText("short output", 80);
    expect(result).toEqual({
      text: "short output",
      truncated: false,
      originalChars: "short output".length,
    });
  });

  it("caps large tool output with a head and tail preview", () => {
    const text = `${"a".repeat(120)}\n${"b".repeat(120)}`;
    const result = truncateModelVisibleToolText(text, 120);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(text.length);
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.text).toContain("Tool output truncated");
    expect(result.text).toContain("Total output lines: 2");
    expect(result.text.startsWith("a")).toBe(true);
    expect(result.text.endsWith("b")).toBe(true);
  });
});
