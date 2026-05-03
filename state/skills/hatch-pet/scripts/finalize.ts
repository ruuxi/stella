#!/usr/bin/env bun
/**
 * Compose a hatch-pet run into the final 1536×1872 sprite atlas.
 *
 * Reads each row strip + the base image, chroma-keys the background to
 * transparency, crops to content, resamples to the row's exact pixel
 * size with nearest-neighbor (so pixel edges stay crisp), tiles into
 * the 8×9 atlas, and writes:
 *
 *   _run/sources/<row>.png         provenance copies of the originals
 *   _run/decoded/<row>.png         chroma-keyed + sized to N*192 × 208
 *   _run/decoded/base.png          chroma-keyed base (for QA only)
 *   final/spritesheet.png          raw 1536×1872 with alpha
 *   final/spritesheet.webp         deliverable
 *   final/validation.json          rule-checking results
 *   qa/contact-sheet.png           every cell laid out for visual review
 *   qa/run-summary.json            end-to-end provenance
 *
 * Deliverable bundle (next to _run/):
 *
 *   pet.json
 *   spritesheet.webp
 *
 * Run from `desktop/` so `sharp` resolves:
 *
 *   cd /Users/rahulnanda/projects/stella/desktop
 *   bun /abs/path/to/finalize.ts \
 *     --run-dir /abs/path/state/pets/<slug>/_run \
 *     --base /abs/path/base.png \
 *     --row idle=/abs/path/idle.png \
 *     --row running-right=/abs/path/running-right.png \
 *     [--mirror running-left=running-right] \
 *     ...
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type SharpFactory from "sharp";

/**
 * Resolve `sharp` from the desktop project so this script works from
 * any cwd. The skill ships under `state/skills/hatch-pet/scripts/`, so
 * the repo root is four `..` up. We never `import` sharp directly —
 * a top-level static import would force the script to live next to a
 * `node_modules/sharp` install, which is exactly what we're avoiding.
 */
const repoRootForSharp = (() => {
  const here = dirname(new URL(import.meta.url).pathname);
  const candidate = resolve(here, "..", "..", "..", "..");
  if (!existsSync(join(candidate, "AGENTS.md"))) {
    throw new Error(
      `cannot locate Stella repo root from ${here} — expected AGENTS.md at ${candidate}`,
    );
  }
  return candidate;
})();
const sharp = createRequire(
  join(repoRootForSharp, "desktop", "package.json"),
)("sharp") as typeof SharpFactory;

interface RowSpec {
  state: string;
  row: number;
  frames: number;
  intent?: string;
}

interface PetRequest {
  petName: string;
  slug: string;
  description: string;
  petNotes?: string;
  styleNotes?: string;
  chromaKey: string;
  referenceImages?: { sourcePath: string; runPath: string }[];
  sheet: {
    width: number;
    height: number;
    cellWidth: number;
    cellHeight: number;
    columns: number;
    rows: number;
  };
  rows: RowSpec[];
  createdAt: string;
}

interface Args {
  runDir: string;
  basePath: string | null;
  rowSources: Record<string, string>;
  mirrors: Record<string, string>;
}

interface RowOutcome {
  state: string;
  row: number;
  frames: number;
  source: string | null;
  mirroredFrom: string | null;
  decodedPath: string;
  contentRatio: number;
  warnings: string[];
  errors: string[];
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    runDir: "",
    basePath: null,
    rowSources: {},
    mirrors: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`flag ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--run-dir":
        args.runDir = next();
        break;
      case "--base":
        args.basePath = next();
        break;
      case "--row": {
        const value = next();
        const eq = value.indexOf("=");
        if (eq <= 0) {
          fail(`--row expects state=path/to/file, got ${value}`);
        }
        const state = value.slice(0, eq).trim();
        const path = value.slice(eq + 1).trim();
        if (!state || !path) fail(`--row expects state=path, got ${value}`);
        args.rowSources[state] = path;
        break;
      }
      case "--mirror": {
        const value = next();
        const eq = value.indexOf("=");
        if (eq <= 0) {
          fail(`--mirror expects target=source, got ${value}`);
        }
        const target = value.slice(0, eq).trim();
        const source = value.slice(eq + 1).trim();
        if (!target || !source) {
          fail(`--mirror expects target=source, got ${value}`);
        }
        args.mirrors[target] = source;
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown flag: ${arg}`);
    }
  }
  if (!args.runDir) fail("missing --run-dir");
  return args;
}

function printHelp(): void {
  console.log(
    `Usage: bun finalize.ts --run-dir DIR [--base PATH] \\
       --row STATE=PATH [--row STATE=PATH ...] \\
       [--mirror TARGET=SOURCE]

Each --row maps an animation state to a generated image_gen output. The
states must match the rows defined in pet_request.json. --mirror lets
you derive one row from another already-supplied row by horizontal
flip; the source row must come from --row, not another --mirror.`,
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  if (cleaned.length !== 6) {
    fail(`invalid chroma color ${hex}`);
  }
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) fail(`invalid chroma color ${hex}`);
  return [r, g, b];
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

async function loadAsRGBA(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

/**
 * Replace every pixel close to `chroma` with full transparency.
 *
 * We use a generous Euclidean RGB tolerance (~70) because diffusion
 * models rarely reproduce a single flat hex even when prompted; they
 * dither and JPEG-compress edges. Pixels within `softZone` of the
 * tolerance get a partial alpha so silhouette edges don't get jagged.
 */
function chromaKeyInPlace(
  img: RawImage,
  chroma: [number, number, number],
): { keyedRatio: number } {
  const tolerance = 70;
  const softZone = 24;
  const tolSq = tolerance * tolerance;
  const softSq = (tolerance + softZone) * (tolerance + softZone);
  let keyed = 0;
  const total = img.width * img.height;
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    const dr = r - chroma[0];
    const dg = g - chroma[1];
    const db = b - chroma[2];
    const distSq = dr * dr + dg * dg + db * db;
    if (distSq <= tolSq) {
      img.data[i + 3] = 0;
      keyed++;
    } else if (distSq <= softSq) {
      // Partial alpha for soft edges. Linear ramp between tol and tol+soft.
      const dist = Math.sqrt(distSq);
      const t = (dist - tolerance) / softZone;
      img.data[i + 3] = Math.round(img.data[i + 3]! * t);
    }
  }
  return { keyedRatio: keyed / total };
}

interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Tightest box containing every non-transparent pixel. */
function contentBounds(img: RawImage): BoundingBox | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function rgbaToPng(img: RawImage): Promise<Buffer> {
  return sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function processRowStrip(args: {
  sourcePath: string;
  spec: RowSpec;
  chroma: [number, number, number];
  cellWidth: number;
  cellHeight: number;
}): Promise<{
  decoded: RawImage;
  contentRatio: number;
  warnings: string[];
  errors: string[];
}> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const targetWidth = args.spec.frames * args.cellWidth;
  const targetHeight = args.cellHeight;

  // Load + chroma-key the original.
  const original = await loadAsRGBA(args.sourcePath);
  const { keyedRatio } = chromaKeyInPlace(original, args.chroma);
  if (keyedRatio < 0.05) {
    warnings.push(
      `only ${(keyedRatio * 100).toFixed(1)}% of pixels keyed — background may not be flat ${`#${args.chroma.map((c) => c.toString(16).padStart(2, "0")).join("")}`}`,
    );
  }

  // Crop to content. If the model added borders, this trims them so the
  // resample fills the cell properly.
  const bbox = contentBounds(original);
  if (!bbox || bbox.width < 8 || bbox.height < 8) {
    errors.push("no content detected after chroma key");
    const empty = Buffer.alloc(targetWidth * targetHeight * 4);
    return {
      decoded: {
        data: empty,
        width: targetWidth,
        height: targetHeight,
        channels: 4,
      },
      contentRatio: 0,
      warnings,
      errors,
    };
  }

  // Resample the keyed strip into the row's exact pixel grid using
  // nearest-neighbor so pixel edges stay sharp. We use sharp for the
  // extract+resize pass because we need it to honor alpha.
  const keyedPng = await rgbaToPng(original);
  const sized = await sharp(keyedPng)
    .extract({
      left: bbox.left,
      top: bbox.top,
      width: bbox.width,
      height: bbox.height,
    })
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "fill",
      kernel: "nearest",
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const decoded: RawImage = {
    data: sized.data,
    width: sized.info.width,
    height: sized.info.height,
    channels: 4,
  };

  // Per-cell coverage check: if any cell ends up empty the model
  // probably produced fewer frames than asked. Surface as a warning, not
  // an error (the row may still be acceptable for short loops).
  const cellPixelCounts: number[] = [];
  for (let f = 0; f < args.spec.frames; f++) {
    let count = 0;
    const xStart = f * args.cellWidth;
    for (let y = 0; y < args.cellHeight; y++) {
      for (let x = xStart; x < xStart + args.cellWidth; x++) {
        const i = (y * decoded.width + x) * 4;
        if (decoded.data[i + 3]! > 8) count++;
      }
    }
    cellPixelCounts.push(count);
  }
  const minCell = cellPixelCounts.reduce((a, b) => Math.min(a, b), Infinity);
  if (minCell === 0) {
    errors.push(
      "at least one cell is fully empty — strip likely had fewer frames than requested",
    );
  } else if (minCell < args.cellWidth * args.cellHeight * 0.02) {
    warnings.push("at least one cell has very little content (<2% pixels)");
  }

  const contentRatio =
    cellPixelCounts.reduce((a, b) => a + b, 0) /
    (decoded.width * decoded.height);

  return { decoded, contentRatio, warnings, errors };
}

function flipHorizontally(img: RawImage): RawImage {
  const out = Buffer.alloc(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const srcI = (y * img.width + x) * 4;
      const dstI = (y * img.width + (img.width - 1 - x)) * 4;
      out[dstI] = img.data[srcI]!;
      out[dstI + 1] = img.data[srcI + 1]!;
      out[dstI + 2] = img.data[srcI + 2]!;
      out[dstI + 3] = img.data[srcI + 3]!;
    }
  }
  return { data: out, width: img.width, height: img.height, channels: 4 };
}

/**
 * Mirror a row strip cell-by-cell rather than a single global flip.
 *
 * If we just flipped the whole strip, frame 0 of running-left would
 * line up with frame N-1 of running-right (reverse animation order).
 * Cell-wise mirroring keeps the play order intact while flipping each
 * pose.
 */
function cellWiseMirror(img: RawImage, frames: number, cellWidth: number): RawImage {
  const flipped = flipHorizontally(img);
  const out = Buffer.alloc(img.data.length);
  for (let f = 0; f < frames; f++) {
    const sourceCellStart = (frames - 1 - f) * cellWidth;
    const targetCellStart = f * cellWidth;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < cellWidth; x++) {
        const srcI = (y * img.width + (sourceCellStart + x)) * 4;
        const dstI = (y * img.width + (targetCellStart + x)) * 4;
        out[dstI] = flipped.data[srcI]!;
        out[dstI + 1] = flipped.data[srcI + 1]!;
        out[dstI + 2] = flipped.data[srcI + 2]!;
        out[dstI + 3] = flipped.data[srcI + 3]!;
      }
    }
  }
  return { data: out, width: img.width, height: img.height, channels: 4 };
}

function pasteIntoAtlas(
  atlas: RawImage,
  strip: RawImage,
  rowIndex: number,
  cellHeight: number,
): void {
  const yOffset = rowIndex * cellHeight;
  for (let y = 0; y < strip.height; y++) {
    const srcRow = y * strip.width * 4;
    const dstRow = ((yOffset + y) * atlas.width + 0) * 4;
    strip.data.copy(
      atlas.data,
      dstRow,
      srcRow,
      srcRow + strip.width * 4,
    );
  }
}

async function buildContactSheet(args: {
  request: PetRequest;
  outcomes: RowOutcome[];
  outPath: string;
}): Promise<void> {
  // Render each cell at 64×64 with a 4px gap so the whole sheet fits
  // comfortably on a laptop screen. Background uses light + dark stripes
  // so transparency remains visible.
  const cellSize = 64;
  const gap = 4;
  const labelHeight = 14;
  const sheetWidth = args.request.sheet.columns * (cellSize + gap) + gap;
  const sheetHeight =
    args.request.sheet.rows * (cellSize + gap + labelHeight) + gap;

  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4);
  // Diagonal-stripe background so transparent areas read as background.
  for (let y = 0; y < sheetHeight; y++) {
    for (let x = 0; x < sheetWidth; x++) {
      const stripe = ((x + y) >> 3) & 1;
      const i = (y * sheetWidth + x) * 4;
      const v = stripe ? 245 : 220;
      sheet[i] = v;
      sheet[i + 1] = v;
      sheet[i + 2] = v;
      sheet[i + 3] = 255;
    }
  }

  for (const outcome of args.outcomes) {
    const decoded = readFileSync(outcome.decodedPath);
    const stripImg = await sharp(decoded)
      .resize({
        width: outcome.frames * cellSize,
        height: cellSize,
        kernel: "nearest",
      })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const yBase =
      outcome.row * (cellSize + gap + labelHeight) + gap + labelHeight;
    for (let f = 0; f < outcome.frames; f++) {
      const cellX = gap + f * (cellSize + gap);
      // Composite each frame manually so we keep the chequerboard background.
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          const srcI = (y * stripImg.info.width + (f * cellSize + x)) * 4;
          const dstI = ((yBase + y) * sheetWidth + (cellX + x)) * 4;
          const a = stripImg.data[srcI + 3]! / 255;
          if (a === 0) continue;
          sheet[dstI] = Math.round(
            stripImg.data[srcI]! * a + sheet[dstI]! * (1 - a),
          );
          sheet[dstI + 1] = Math.round(
            stripImg.data[srcI + 1]! * a + sheet[dstI + 1]! * (1 - a),
          );
          sheet[dstI + 2] = Math.round(
            stripImg.data[srcI + 2]! * a + sheet[dstI + 2]! * (1 - a),
          );
        }
      }
    }
  }

  await sharp(sheet, {
    raw: { width: sheetWidth, height: sheetHeight, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(args.outPath);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDirAbs = isAbsolute(args.runDir)
    ? args.runDir
    : resolve(process.cwd(), args.runDir);
  if (!existsSync(runDirAbs)) {
    fail(`run dir not found: ${runDirAbs}`);
  }
  const requestPath = join(runDirAbs, "pet_request.json");
  if (!existsSync(requestPath)) {
    fail(`pet_request.json not found in ${runDirAbs} — was prepare.ts run?`);
  }
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as PetRequest;
  const chroma = hexToRgb(request.chromaKey);

  const sourcesDir = join(runDirAbs, "sources");
  const decodedDir = join(runDirAbs, "decoded");
  const finalDir = join(runDirAbs, "final");
  const qaDir = join(runDirAbs, "qa");
  for (const dir of [sourcesDir, decodedDir, finalDir, qaDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Validate every row has a source or a mirror that resolves.
  const missingRows: string[] = [];
  for (const spec of request.rows) {
    const haveSource = Boolean(args.rowSources[spec.state]);
    const mirrorTarget = args.mirrors[spec.state];
    const haveMirror = Boolean(mirrorTarget);
    if (!haveSource && !haveMirror) {
      missingRows.push(spec.state);
    }
    if (haveMirror && args.mirrors[mirrorTarget]) {
      fail(
        `--mirror ${spec.state}=${mirrorTarget} chains through another mirror; the source row must come from --row`,
      );
    }
  }
  if (missingRows.length > 0) {
    fail(
      `missing --row or --mirror for: ${missingRows.join(", ")}\n  expected rows: ${request.rows
        .map((spec) => spec.state)
        .join(", ")}`,
    );
  }

  // Record base for QA: chroma-key it but don't compose into the atlas.
  if (args.basePath) {
    const baseAbs = isAbsolute(args.basePath)
      ? args.basePath
      : resolve(process.cwd(), args.basePath);
    if (!existsSync(baseAbs)) fail(`base image not found: ${baseAbs}`);
    copyFileSync(baseAbs, join(sourcesDir, "base.png"));
    const baseImg = await loadAsRGBA(baseAbs);
    chromaKeyInPlace(baseImg, chroma);
    const baseDecoded = join(decodedDir, "base.png");
    await sharp(baseImg.data, {
      raw: {
        width: baseImg.width,
        height: baseImg.height,
        channels: 4,
      },
    })
      .png({ compressionLevel: 9 })
      .toFile(baseDecoded);
    // Also stash a canonical reference next to user references, so
    // future repair runs and the original prepare.ts contract align.
    const refDir = join(runDirAbs, "references");
    mkdirSync(refDir, { recursive: true });
    copyFileSync(baseDecoded, join(refDir, "canonical-base.png"));
  }

  // Process each row in declared order so atlas rows match the spec.
  const outcomes: RowOutcome[] = [];
  for (const spec of request.rows) {
    const sourcePath = args.rowSources[spec.state];
    const mirrorTarget = args.mirrors[spec.state];

    let decodedRaw: RawImage;
    let resolvedSource: string | null = null;
    let mirroredFrom: string | null = null;
    const warnings: string[] = [];
    const errors: string[] = [];
    let contentRatio = 0;

    if (mirrorTarget) {
      const sourceOutcome = outcomes.find((entry) => entry.state === mirrorTarget);
      if (!sourceOutcome) {
        fail(
          `mirror source ${mirrorTarget} for ${spec.state} must appear earlier in pet_request.json`,
        );
      }
      const sourceDecoded = await loadAsRGBA(sourceOutcome.decodedPath);
      decodedRaw = cellWiseMirror(
        sourceDecoded,
        spec.frames,
        request.sheet.cellWidth,
      );
      mirroredFrom = mirrorTarget;
      contentRatio = sourceOutcome.contentRatio;
    } else {
      const abs = isAbsolute(sourcePath!)
        ? sourcePath!
        : resolve(process.cwd(), sourcePath!);
      if (!existsSync(abs)) fail(`row source not found: ${abs}`);
      copyFileSync(abs, join(sourcesDir, `${spec.state}.png`));
      resolvedSource = abs;

      const result = await processRowStrip({
        sourcePath: abs,
        spec,
        chroma,
        cellWidth: request.sheet.cellWidth,
        cellHeight: request.sheet.cellHeight,
      });
      decodedRaw = result.decoded;
      contentRatio = result.contentRatio;
      warnings.push(...result.warnings);
      errors.push(...result.errors);
    }

    const decodedPath = join(decodedDir, `${spec.state}.png`);
    await sharp(decodedRaw.data, {
      raw: {
        width: decodedRaw.width,
        height: decodedRaw.height,
        channels: 4,
      },
    })
      .png({ compressionLevel: 9 })
      .toFile(decodedPath);

    outcomes.push({
      state: spec.state,
      row: spec.row,
      frames: spec.frames,
      source: resolvedSource,
      mirroredFrom,
      decodedPath,
      contentRatio,
      warnings,
      errors,
    });
  }

  // Atlas assembly.
  const atlas: RawImage = {
    data: Buffer.alloc(request.sheet.width * request.sheet.height * 4),
    width: request.sheet.width,
    height: request.sheet.height,
    channels: 4,
  };
  for (const outcome of outcomes) {
    const decodedRaw = await loadAsRGBA(outcome.decodedPath);
    pasteIntoAtlas(atlas, decodedRaw, outcome.row, request.sheet.cellHeight);
  }

  const atlasPng = join(finalDir, "spritesheet.png");
  const atlasWebp = join(finalDir, "spritesheet.webp");
  await sharp(atlas.data, {
    raw: {
      width: atlas.width,
      height: atlas.height,
      channels: 4,
    },
  })
    .png({ compressionLevel: 9 })
    .toFile(atlasPng);
  await sharp(atlas.data, {
    raw: {
      width: atlas.width,
      height: atlas.height,
      channels: 4,
    },
  })
    .webp({ quality: 92, lossless: false, alphaQuality: 100 })
    .toFile(atlasWebp);

  // Validation — surface warnings and errors but don't bail; the agent
  // and the user need to see what happened to decide whether to repair.
  const validation = {
    petSlug: request.slug,
    sheet: request.sheet,
    rows: outcomes.map((outcome) => ({
      state: outcome.state,
      row: outcome.row,
      frames: outcome.frames,
      source: outcome.source,
      mirroredFrom: outcome.mirroredFrom,
      contentRatio: Number(outcome.contentRatio.toFixed(4)),
      warnings: outcome.warnings,
      errors: outcome.errors,
    })),
    finalAtlas: { png: atlasPng, webp: atlasWebp },
    finalizedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(finalDir, "validation.json"),
    JSON.stringify(validation, null, 2) + "\n",
  );

  // Contact sheet.
  const contactPath = join(qaDir, "contact-sheet.png");
  await buildContactSheet({
    request,
    outcomes,
    outPath: contactPath,
  });

  // Provenance manifest update.
  const manifestPath = join(runDirAbs, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    petSlug: string;
    base: Record<string, unknown>;
    rows: Record<string, Record<string, unknown>>;
  };
  if (args.basePath) {
    manifest.base.sourcePath = args.basePath;
    manifest.base.decodedPath = join(decodedDir, "base.png");
    manifest.base.recordedAt = new Date().toISOString();
  }
  for (const outcome of outcomes) {
    manifest.rows[outcome.state] = {
      ...manifest.rows[outcome.state],
      sourcePath: outcome.source,
      decodedPath: outcome.decodedPath,
      mirroredFrom: outcome.mirroredFrom,
      recordedAt: new Date().toISOString(),
    };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // Stage the deliverable bundle next to _run/ — the renderer reads
  // pet.json + spritesheet.webp from this folder.
  const petDir = dirname(runDirAbs);
  const petJsonPath = join(petDir, "pet.json");
  const petWebpPath = join(petDir, "spritesheet.webp");
  const petJson = {
    id: request.slug,
    displayName: request.petName,
    description: request.description,
    spritesheetPath: "spritesheet.webp",
    creator:
      process.env.STELLA_PET_CREATOR ||
      process.env.USER ||
      process.env.USERNAME ||
      "you",
  };
  writeFileSync(petJsonPath, JSON.stringify(petJson, null, 2) + "\n");
  copyFileSync(atlasWebp, petWebpPath);

  // Final summary.
  const errorCount = outcomes.reduce(
    (total, outcome) => total + outcome.errors.length,
    0,
  );
  const warnCount = outcomes.reduce(
    (total, outcome) => total + outcome.warnings.length,
    0,
  );
  const summary = {
    petSlug: request.slug,
    petName: request.petName,
    deliverable: { petJson: petJsonPath, webp: petWebpPath },
    contactSheet: contactPath,
    validation: join(finalDir, "validation.json"),
    rowSummaries: outcomes.map((outcome) => ({
      state: outcome.state,
      mirroredFrom: outcome.mirroredFrom,
      errors: outcome.errors.length,
      warnings: outcome.warnings.length,
    })),
    finalizedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(qaDir, "run-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );

  console.log(
    `hatched ${request.petName} (slug: ${request.slug}) with ${errorCount} errors, ${warnCount} warnings`,
  );
  console.log(`  spritesheet:    ${petWebpPath}`);
  console.log(`  pet.json:       ${petJsonPath}`);
  console.log(`  contact sheet:  ${contactPath}`);
  console.log(`  validation:     ${join(finalDir, "validation.json")}`);
  if (errorCount > 0) {
    console.log("");
    console.log(
      "errors detected — open the contact sheet, regenerate the failing rows with image_gen, and re-run finalize.ts with the new --row paths.",
    );
    process.exit(2);
  }
}

void main().catch((err) => {
  console.error("finalize failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
