#!/usr/bin/env bun
/**
 * Scaffold a hatch-pet run folder.
 *
 * Writes:
 *
 *   state/pets/<slug>/_run/
 *     pet_request.json
 *     manifest.json
 *     prompts/base.md
 *     prompts/<row>.md   (one per animation state)
 *     references/        (copies of every user-provided reference)
 *
 * Idempotent only by virtue of refusing to overwrite an existing _run/.
 * Re-run after deleting `_run/` (or under a different slug) when the
 * pet name or references change. The deliverable bundle (`pet.json` and
 * `spritesheet.webp`) lands one level up after `finalize.ts` runs.
 *
 * Usage:
 *   bun /abs/path/to/prepare.ts \
 *     [--pet-name "Sprig"] \
 *     [--description "A leafy companion for green builds."] \
 *     [--pet-notes "leafy mascot, single sprout, cheerful"] \
 *     [--style-notes "extra-thick outline"] \
 *     [--reference /abs/path.png] [--reference ...] \
 *     [--chroma "#00ff00"] \
 *     [--output-root state/pets]
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

interface Args {
  petName: string | null;
  description: string | null;
  petNotes: string;
  styleNotes: string;
  references: string[];
  chroma: string;
  outputRoot: string;
}

interface RowSpec {
  state: string;
  row: number;
  frames: number;
  /** One-line guidance the prompt body folds in. */
  intent: string;
}

const ROWS: RowSpec[] = [
  {
    state: "idle",
    row: 0,
    frames: 6,
    intent:
      "ambient breathing pose. Subtle chest/head movement only — no walking, no waving.",
  },
  {
    state: "running-right",
    row: 1,
    frames: 8,
    intent:
      "facing right, scampering. Body and limbs in motion; no speed lines, dust, or shadows.",
  },
  {
    state: "running-left",
    row: 2,
    frames: 8,
    intent:
      "facing left, scampering. Mirror of running-right when symmetric. No speed lines, dust, or shadows.",
  },
  {
    state: "waving",
    row: 3,
    frames: 4,
    intent:
      "warm greeting through paw pose only. No wave marks, motion arcs, sparkles, or symbols.",
  },
  {
    state: "jumping",
    row: 4,
    frames: 5,
    intent:
      "vertical hop arc through body position only. No shadows, dust, landing marks, or impact bursts.",
  },
  {
    state: "failed",
    row: 5,
    frames: 8,
    intent:
      "dizzy / shocked / shaken reaction. Attached opaque tears, stars, or smoke puffs allowed only if they overlap the silhouette. No detached symbols.",
  },
  {
    state: "waiting",
    row: 6,
    frames: 6,
    intent:
      "polite 'needs input' loop. Looking up / tapping / glancing. No question marks or thought bubbles.",
  },
  {
    state: "running",
    row: 7,
    frames: 6,
    intent:
      "in-place scamper used while a turn is streaming. Bouncy and busy. No motion trails.",
  },
  {
    state: "review",
    row: 8,
    frames: 6,
    intent:
      "just-finished focus / cheer pose. Lean, blink, head tilt, paw position. No magnifying glass or UI props unless already part of the pet identity.",
  },
];

function parseArgs(argv: string[]): Args {
  const out: Args = {
    petName: null,
    description: null,
    petNotes: "",
    styleNotes: "",
    references: [],
    chroma: "#00ff00",
    outputRoot: "state/pets",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        fail(`flag ${arg} requires a value`);
      }
      return v;
    };
    switch (arg) {
      case "--pet-name":
        out.petName = next().trim();
        break;
      case "--description":
        out.description = next().trim();
        break;
      case "--pet-notes":
        out.petNotes = next();
        break;
      case "--style-notes":
        out.styleNotes = next();
        break;
      case "--reference":
        out.references.push(next());
        break;
      case "--chroma":
        out.chroma = next().trim();
        break;
      case "--output-root":
        out.outputRoot = next().trim();
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown flag: ${arg}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    `Usage: bun prepare.ts [--pet-name NAME] [--description ONE_SENTENCE] \\
       [--pet-notes "stable description used in every prompt"] \\
       [--style-notes "extra style guidance"] \\
       [--reference /abs/path.png] [--reference ...] \\
       [--chroma "#00ff00"] [--output-root state/pets]

All flags are optional. Inferred defaults:
  --pet-name        first capitalized word from --pet-notes, else "Pet"
  --description     "<Pet name> — a custom Stella pet."
  --output-root     state/pets (relative to repo root)
  --chroma          #00ff00 (used by finalize to remove the background)`,
  );
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function findRepoRoot(): string {
  // The skill ships at state/skills/hatch-pet/scripts/prepare.ts, so the
  // repo root is the third parent of this script's dir. We confirm by
  // checking for the AGENTS.md sibling that AGENTS workflows rely on,
  // so an out-of-tree copy of the skill fails loudly.
  const here = dirname(new URL(import.meta.url).pathname);
  const candidate = resolve(here, "..", "..", "..", "..");
  if (!existsSync(join(candidate, "AGENTS.md"))) {
    fail(
      `could not locate Stella repo root from ${here} — expected AGENTS.md at ${candidate}`,
    );
  }
  return candidate;
}

function slugifyName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base.slice(0, 48) : "pet";
}

function inferName(notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) return "Pet";
  // First capitalized run of letters (max 2 words) makes a friendly name.
  const match = trimmed.match(/[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?/);
  if (match) return match[0];
  // Otherwise grab the first noun-ish token, capitalized.
  const word = trimmed.split(/\s+/, 1)[0]!.replace(/[^a-zA-Z]/g, "");
  if (!word) return "Pet";
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

function inferDescription(name: string, notes: string): string {
  const trimmed = notes.trim();
  if (trimmed) return `${name} — ${trimmed.replace(/\.$/, "")}.`;
  return `${name} — a custom Stella pet.`;
}

function ensureChroma(value: string): string {
  const cleaned = value.startsWith("#") ? value : `#${value}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
    fail(`--chroma must be a hex color like #00ff00, got ${value}`);
  }
  return cleaned.toLowerCase();
}

function buildBasePrompt(args: {
  name: string;
  description: string;
  petNotes: string;
  styleNotes: string;
  chroma: string;
  hasReferences: boolean;
}): string {
  const refLine = args.hasReferences
    ? "Use the attached reference image(s) as identity grounding — keep the same head shape, palette, and props. Translate any detail or realism into Stella's pixel-art style."
    : "Design from the description below; this image will become the canonical reference for every row, so commit to a clear identity.";
  return `# Base look — ${args.name}

Generate a single ${args.name} pet, centered, full body visible, facing the viewer, on a flat ${args.chroma} background. Output one pet only — no companions, no props that aren't part of the pet's identity, no UI, no text, no border, no shadow.

## Pet identity

${args.petNotes.trim() || `${args.name}, a friendly Stella mascot.`}

## Style

Small pixel-art-adjacent mascot. Chunky readable silhouette. Thick dark 1–2 px outline. Visible stepped pixel edges. Limited palette. Flat cel shading. Simple expressive face. Tiny limbs.${args.styleNotes.trim() ? `\n\nAdditional style notes: ${args.styleNotes.trim()}` : ""}

## Grounding

${refLine}

## Background and effects

Background must be a single flat ${args.chroma} (true RGB, no gradient, no noise, no other green tones in the pet).

Do not include: motion blur, speed lines, shadows, drop shadows, glow, halo, soft transparent effects, scenery, props that aren't part of the pet identity, text, labels, watermarks, frames, borders, UI, checkerboard transparency, or chroma-key-adjacent green inside the pet.
`;
}

function buildRowPrompt(args: {
  name: string;
  petNotes: string;
  styleNotes: string;
  chroma: string;
  spec: RowSpec;
}): string {
  const { spec } = args;
  return `# Row strip — ${spec.state} (${spec.frames} frames)

Generate ${spec.frames} frames of the same ${args.name} pet performing the **${spec.state}** animation, laid out left-to-right as a single horizontal strip on a flat ${args.chroma} background.

Animation intent: ${spec.intent}

## Pet identity (must match the canonical base)

${args.petNotes.trim() || `${args.name}, the same pet from the canonical base reference.`}

Keep the head shape, face, markings, palette, prop, outline weight, body proportions, and silhouette identical to the canonical base. A row that looks like a different pet fails even when the geometry passes.

## Layout

- Single horizontal strip with exactly ${spec.frames} frames left to right.
- Each frame is a clean square cell. Frames are evenly spaced. No bleeding into neighbors.
- Centered subjects in each cell, with breathing room around the silhouette so the chroma key has clean edges.
- Background is a single flat ${args.chroma} (true RGB, no gradient or noise). No scenery, no floor, no shadow.

## Style

Same pixel-art-adjacent style as the base. Thick 1–2 px dark outlines. Visible stepped pixel edges. Limited palette. Flat cel shading.${args.styleNotes.trim() ? `\n\nAdditional style notes: ${args.styleNotes.trim()}` : ""}

## Forbidden in this row

- No detached effects (sparkles, stars, smoke, dust, droplets, sweat, blur, smears, motion lines, speed lines, after-images, halo, glow, aura, soft transparent effects).
- No shadows, drop shadows, contact shadows, floor shadows, or oval ground patches.
- No labels, frame numbers, captions, speech bubbles, thought bubbles, UI, code, or punctuation marks.
- No chroma-key-adjacent colors inside the pet, prop, or any allowed attached effect.
- No cropped, mirrored-by-accident, or slot-crossing poses.
${spec.state === "waving" ? "- No wave marks, motion arcs, sparkles, or symbols around the paw — convey the wave through the paw pose only.\n" : ""}${spec.state === "jumping" ? "- No bounce pads, dust, landing marks, oval shadows, or impact bursts — convey the hop through body position only.\n" : ""}${spec.state === "running" || spec.state === "running-left" || spec.state === "running-right" ? "- No speed lines, motion trails, dust clouds, floor shadows, or after-images — convey locomotion through limb / body position only.\n" : ""}${spec.state === "review" ? "- No magnifying glasses, papers, code, UI, or punctuation unless that prop is already part of the pet identity.\n" : ""}${spec.state === "failed" ? "- Tears, smoke puffs, or stars are allowed only when opaque, hard-edged, sprite-style, and physically overlapping the pet silhouette. No floating symbols, no separated droplets.\n" : ""}
`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  args.chroma = ensureChroma(args.chroma);

  const repoRoot = findRepoRoot();
  const petName = (args.petName ?? inferName(args.petNotes)).trim() || "Pet";
  const description = (
    args.description ?? inferDescription(petName, args.petNotes)
  ).trim();
  const slug = slugifyName(petName);

  const outputRootAbs = isAbsolute(args.outputRoot)
    ? args.outputRoot
    : resolve(repoRoot, args.outputRoot);
  const petDir = join(outputRootAbs, slug);
  const runDir = join(petDir, "_run");
  const promptsDir = join(runDir, "prompts");
  const referencesDir = join(runDir, "references");

  if (existsSync(runDir)) {
    fail(
      `${runDir} already exists. Delete it first or pass a different --pet-name to start a fresh run.`,
    );
  }

  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(referencesDir, { recursive: true });

  // Validate + copy references with deduped, hash-stable names so prompts
  // can reference them by relative path without leaking user disk paths.
  const referenceEntries: { source: string; copied: string }[] = [];
  for (const refPath of args.references) {
    const abs = isAbsolute(refPath) ? refPath : resolve(process.cwd(), refPath);
    if (!existsSync(abs)) {
      fail(`reference not found: ${abs}`);
    }
    const ext = (basename(abs).split(".").pop() ?? "png").toLowerCase();
    const safeName = `user-${String(referenceEntries.length + 1).padStart(2, "0")}.${ext}`;
    const dest = join(referencesDir, safeName);
    copyFileSync(abs, dest);
    referenceEntries.push({ source: abs, copied: dest });
  }

  // Write per-row prompts.
  writeFileSync(
    join(promptsDir, "base.md"),
    buildBasePrompt({
      name: petName,
      description,
      petNotes: args.petNotes,
      styleNotes: args.styleNotes,
      chroma: args.chroma,
      hasReferences: referenceEntries.length > 0,
    }),
  );
  for (const spec of ROWS) {
    writeFileSync(
      join(promptsDir, `${spec.state}.md`),
      buildRowPrompt({
        name: petName,
        petNotes: args.petNotes,
        styleNotes: args.styleNotes,
        chroma: args.chroma,
        spec,
      }),
    );
  }

  // pet_request.json: stable inputs for every downstream script.
  const petRequest = {
    petName,
    slug,
    description,
    petNotes: args.petNotes,
    styleNotes: args.styleNotes,
    chromaKey: args.chroma,
    referenceImages: referenceEntries.map((entry) => ({
      sourcePath: entry.source,
      runPath: entry.copied,
    })),
    sheet: {
      width: 1536,
      height: 1872,
      cellWidth: 192,
      cellHeight: 208,
      columns: 8,
      rows: 9,
    },
    rows: ROWS.map((spec) => ({
      state: spec.state,
      row: spec.row,
      frames: spec.frames,
      intent: spec.intent,
    })),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(
    join(runDir, "pet_request.json"),
    JSON.stringify(petRequest, null, 2) + "\n",
  );

  // manifest.json: tracks job state. Filled in by finalize.ts.
  const manifest = {
    petSlug: slug,
    base: {
      promptPath: join(promptsDir, "base.md"),
      sourcePath: null as string | null,
      decodedPath: null as string | null,
      recordedAt: null as string | null,
    },
    rows: Object.fromEntries(
      ROWS.map((spec) => [
        spec.state,
        {
          promptPath: join(promptsDir, `${spec.state}.md`),
          sourcePath: null as string | null,
          decodedPath: null as string | null,
          mirroredFrom: null as string | null,
          recordedAt: null as string | null,
        },
      ]),
    ),
  };
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // Friendly summary.
  console.log(`prepared hatch-pet run for "${petName}" (slug: ${slug})`);
  console.log(`  run dir:      ${runDir}`);
  console.log(`  prompts:      ${promptsDir}`);
  console.log(
    `  references:   ${
      referenceEntries.length > 0
        ? referenceEntries.map((entry) => entry.copied).join(", ")
        : "(none — base will be prompt-only)"
    }`,
  );
  console.log(`  chroma key:   ${args.chroma}`);
  console.log("");
  console.log("next:");
  console.log(`  1. image_gen with prompt body of ${join(promptsDir, "base.md")}`);
  console.log(
    `     (attach references/* as referenceImagePaths if any user references exist)`,
  );
  console.log(`  2. image_gen for each row prompt under ${promptsDir}`);
  console.log(
    `     (always attach the recorded base + any user references; for parallelism delegate one row per subagent)`,
  );
  console.log(`  3. cd /Users/rahulnanda/projects/stella/desktop && \\`);
  console.log(`     bun ${dirname(new URL(import.meta.url).pathname)}/finalize.ts \\`);
  console.log(`       --run-dir ${runDir} \\`);
  console.log(`       --base /abs/path/to/base.png \\`);
  console.log(`       --row idle=/abs/path/to/idle.png \\`);
  console.log(`       --row running-right=/abs/path/to/running-right.png ...`);

  // Read-back sanity: load manifest just-written to confirm shape parses.
  JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
}

main();
