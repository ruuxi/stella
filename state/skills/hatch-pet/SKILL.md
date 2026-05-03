---
name: hatch-pet
description: Hatch a custom animated Stella pet (1536×1872 sprite atlas) from a concept and optional reference images. Generates the base look and 9 animation rows via image_gen, then composes the final spritesheet and pet.json under state/pets/<slug>/.
---

# Hatch a Stella pet

Use this skill when the user asks for a custom Stella pet — a tiny animated mascot that lives in the floating overlay and reacts to chat activity. The pet renders inside Stella's existing pet overlay, so the only deliverable is a spritesheet + small JSON manifest written under `state/pets/<slug>/`.

User-facing inputs are optional. If the user omits a name, infer one from the concept or reference filenames; if neither suggests anything, pick a short friendly name. If they omit a description, infer one from the concept or references. If they omit reference images, generate the base from text first and reuse that base as the canonical reference for every row.

## Visual style

Stella pets are small pixel-art-adjacent mascots with chunky readable silhouettes, thick dark 1–2 px outlines, visible stepped/pixel edges, limited palettes, flat cel shading, simple expressive faces, and tiny limbs. Even when the user provides a detailed or realistic reference, simplify it into this style.

Avoid: polished illustration, painterly rendering, anime key art, 3D rendering, glossy app-icon treatment, realistic fur or material texture, soft gradients, high-detail antialiasing, or complex tiny accessories.

## Sheet geometry

The final atlas is 1536 × 1872, transparent-capable, arranged as **8 columns × 9 rows of 192 × 208 cells**. Each row is one animation state. The renderer (`desktop/src/shell/pet/sprite-frames.ts`) plays the rows below, so any pet folder that follows this layout is playable.

| Row | State           | Frames | Notes                                                    |
| --- | --------------- | ------ | -------------------------------------------------------- |
| 0   | `idle`          | 6      | Slow "breathing" loop. The pet's resting pose lives here |
| 1   | `running-right` | 8      | Locomotion to the right                                  |
| 2   | `running-left`  | 8      | Locomotion to the left                                   |
| 3   | `waving`        | 4      | Greeting / "wake up" reaction                            |
| 4   | `jumping`       | 5      | Hop arc                                                  |
| 5   | `failed`        | 8      | Dizzy / shocked / blue-screen reaction                   |
| 6   | `waiting`       | 6      | Polite "needs input" loop                                |
| 7   | `running`       | 6      | Scampering in place — used while a turn is streaming     |
| 8   | `review`        | 6      | Just-finished cheer / focus pose                         |

Used cells must be non-empty; unused cells must be fully transparent.

## Transparency and effects

Frames are chroma-keyed to transparency by `finalize.ts`, so every generated pixel must either belong to the pet sprite or be cleanly removable background. Prefer pose, expression, and silhouette changes over decorative effects.

Allowed effects must satisfy all of:

- State-relevant and helps explain the animation.
- Physically attached to or overlapping the pet silhouette, not floating nearby.
- Inside the same frame slot as the pet, not a separate sprite component.
- Opaque, hard-edged, pixel-style, in colors that are not chroma-key-adjacent.
- Small enough to read at 192 × 208 without clutter.

Avoid by default: motion arcs / speed lines / smears / blur / afterimages, detached stars / sparkles / smoke / dust / floating punctuation, cast shadows / drop shadows / floor patches / impact bursts / glow / halos / aura / soft transparent effects, text / labels / frame numbers / visible grids / guide marks / speech bubbles / UI panels, chroma-key-adjacent colors anywhere in the pet, stray pixels / disconnected outline bits, and any pose that crosses into a neighboring frame slot.

State-specific guidance:

- **waving**: convey through paw pose only — no wave marks, motion arcs, or symbols around the paw.
- **jumping**: convey vertical motion through body position only — no shadows, dust, landing marks, impact bursts, or floor cues.
- **failed**: attached tears, smoke puffs, or stars that overlap the silhouette are allowed if they obey the allowed-effects rules. No red Xs, floating symbols, detached smoke, or separated tear droplets.
- **review**: focus through lean, blink, eye direction, head tilt, paw position. No magnifying glasses, papers, code, UI, or punctuation unless the prop is part of the base pet identity.
- **running-right / running-left / running**: locomotion through body, limb, and prop movement only. No speed lines, dust clouds, floor shadows, or motion trails.

Identity drift is a blocker even when geometry passes: if a row looks like a different pet, fail it.

## Visible progress plan

Keep the user oriented with a short checklist. Establish the pet name first (use the user's name when given; otherwise infer a short friendly one). Substitute `<Pet>` with the chosen name, or "your pet" if you have not landed on one yet:

1. Getting `<Pet>` ready.
2. Imagining `<Pet>`'s main look.
3. Picturing `<Pet>`'s poses.
4. Hatching `<Pet>`.

What each step means:

- **Getting `<Pet>` ready** — choose / confirm pet name, description, reference images, and run folder.
- **Imagining `<Pet>`'s main look** — generate the base reference. Required for new pets even when the user provided no images, because the base becomes the visual source of truth for every row.
- **Picturing `<Pet>`'s poses** — generate the row strips, starting with `idle` and `running-right` as identity / gait checks. Only mirror `running-left` if `running-right` clearly works flipped.
- **Hatching `<Pet>`** — compose the atlas, run the contact-sheet review, fix any broken rows, write `pet.json` and `spritesheet.webp`, then tell the user where the pet was saved.

Only mark a step complete when the actual file or decision exists.

## Default workflow

This skill has two scripts. Run them with bun, from the desktop project (so `sharp` resolves):

```bash
cd /Users/rahulnanda/projects/stella/desktop
SKILL_DIR=/Users/rahulnanda/projects/stella/state/skills/hatch-pet
```

### 1. Prepare the run folder

```bash
bun "$SKILL_DIR/scripts/prepare.ts" \
  --pet-name "<Name>" \
  --description "<one short sentence>" \
  --pet-notes "<stable pet description, used in every prompt>" \
  --style-notes "<optional house-style additions>" \
  --reference /absolute/path/to/reference1.png \
  --reference /absolute/path/to/reference2.png
```

All flags are optional except those needed to express user intent. With no flags, `prepare.ts` infers a pet name and description from the concept (passed via `--pet-notes`) or falls back to `Pet`. It writes:

```
state/pets/<slug>/_run/
  pet_request.json          # name, description, chroma key, references
  manifest.json             # row job state + provenance (sources land here)
  prompts/base.md           # base pet prompt
  prompts/<row>.md          # one prompt per animation row
  references/                # copies of every user-provided reference
```

`<slug>` is the lowercase-hyphenated form of the pet name. `prepare.ts` refuses to overwrite an existing `_run/` so re-running is safe.

### 2. Generate the base look

Use the `image_gen` tool with the `prompts/base.md` body as the prompt. Pass every user reference (`references/*` from the run folder) as `referenceImagePaths`. Save the chosen result path for the next step.

The base job is the only job allowed to be prompt-only (when the user provided no references).

### 3. Generate each row

For every row in the table above, call `image_gen` with that row's `prompts/<row>.md` body. Always attach **both** `references/canonical-base.png` (the recorded base from step 2) and any user references, so the model preserves identity. Generate `running-right` before deciding what to do with `running-left`:

- If the pet is symmetric enough that a horizontal flip preserves identity, prop placement, handedness, markings, lighting, and direction semantics, let `finalize.ts` mirror it (pass `--mirror running-left=running-right`).
- If anything would read wrong flipped (one-sided prop, asymmetric markings, readable text, handed pose), generate `running-left` with `image_gen` like any other row.

When you generate the base or any row, the result lands at a path under `state/media/outputs/...` returned by `image_gen`. Keep those paths — `finalize.ts` reads them via flags.

#### Parallelism

When working as the orchestrator, delegate row jobs to general-agent subagents (one row per subagent) so they run in parallel. Hand the subagent the row id, the absolute prompt file path, and the canonical base + any references with their role labels. The subagent's only output is the chosen `state/media/outputs/.../*.png` path plus a one-line QA note. The parent owns recording sources and finalizing — subagents must not run `finalize.ts`, must not edit `manifest.json`, and must not move files into `_run/`.

When you are the general agent yourself, run row jobs in parallel via `multi_tool_use.parallel` instead of one-at-a-time.

If neither subagent delegation nor parallel tool calls are available (tooling disabled or environment blocks them), stop and ask before proceeding sequentially.

### 4. Finalize

```bash
bun "$SKILL_DIR/scripts/finalize.ts" \
  --run-dir /absolute/path/to/state/pets/<slug>/_run \
  --base /absolute/path/to/base/output.png \
  --row idle=/abs/path/idle.png \
  --row running-right=/abs/path/running-right.png \
  --row running-left=/abs/path/running-left.png \
  --row waving=/abs/path/waving.png \
  --row jumping=/abs/path/jumping.png \
  --row failed=/abs/path/failed.png \
  --row waiting=/abs/path/waiting.png \
  --row running=/abs/path/running.png \
  --row review=/abs/path/review.png
```

To mirror `running-left` from `running-right` instead of providing a generated source for it, swap the `--row running-left=...` flag for:

```bash
  --mirror running-left=running-right
```

`finalize.ts`:

1. Copies each source into `_run/sources/<row>.png` for provenance.
2. Chroma-keys the background to transparency using the chroma color recorded in `pet_request.json` (default `#00ff00`).
3. Crops each strip to its content bounding box, then resamples to the row's exact pixel size (`frames × 192 × 208`) using nearest-neighbor so pixel edges stay crisp.
4. Composes everything into the 1536 × 1872 atlas with unused cells fully transparent.
5. Writes `final/spritesheet.png` (raw PNG with alpha), `final/spritesheet.webp` (the deliverable), `qa/contact-sheet.png` (every cell laid out for review), and `final/validation.json`.
6. Stages the deliverable bundle next to `_run/`:

```
state/pets/<slug>/
  pet.json
  spritesheet.webp
  _run/                     # kept for QA + repairs
```

`pet.json` matches the shape the renderer reads — `{ id, displayName, description, spritesheetPath, creator }`.

## Acceptance

Before telling the user the pet is done:

- Open `qa/contact-sheet.png` and confirm every row is the same pet (face, markings, palette, prop). Identity drift fails the run regardless of geometry.
- `final/validation.json` has no errors. Warnings need a quick visual pass; errors block.
- The contact sheet does not show repeated tiles, white cell backgrounds, cropped references, scenery, UI, text, or non-sprite fragments.
- No row contains forbidden detached effects, motion trails, shadows, dust, landing marks, glow, or chroma-key-adjacent artifacts.

If a row fails, regenerate **only that row** with `image_gen` (re-attach the canonical base and the contact sheet so the model sees the rest of the pet), then re-run `finalize.ts` with the new path. Repair the smallest failing scope, never the whole sheet.

## Hard rules

- Use `image_gen` for every visual job. Do not draw, tile, warp, mirror, or synthesize sprites with local code as a substitute. The deterministic scripts in this skill only process already-generated images.
- The base job is the only job that may be prompt-only. Every row job must attach the canonical base and any user references.
- Generate `running-right` first; only mirror `running-left` after visually confirming the mirror preserves identity and direction semantics.
- Never hand-edit `manifest.json` to claim a job complete. The finalize script records provenance.
- Use the chroma key stored in `pet_request.json`; do not switch it mid-run.
- Keep silhouette, face, materials, palette, and props consistent across every row.
- Treat visual identity drift as a blocker even when validation passes.
- Stage `pet.json` + `spritesheet.webp` together at `state/pets/<slug>/`. Don't leave the pet half-installed.
