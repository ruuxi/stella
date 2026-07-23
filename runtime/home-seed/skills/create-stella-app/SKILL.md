---
name: create-stella-app
description: Scaffold a new single-file Stella app under desktop/src/app/_user. Use when the user asks Stella to build them an app, then edit only the generated file.
---

# Creating a Stella app

A Stella app is **one file**: `desktop/src/app/_user/<slug>.tsx`. It
appears on the `/apps` page automatically and opens at `/apps/<slug>`.
No nav entry of its own. No multi-file scaffold.

## Scaffold

Run from the Stella install root (the directory containing `desktop/` and
`runtime/`) so the script writes into the tree the running
app loads from:

```sh
bun runtime/home-seed/skills/create-stella-app/scripts/program.ts <slug> <label words...>
```

`<slug>` is lowercase `[a-z][a-z0-9-]*`, ≤32 chars (the URL segment).
`<label>` is whatever you'd call the app in conversation; the script
takes the rest of the args verbatim.

It creates exactly one file:

```
desktop/src/app/_user/<slug>.tsx
```

That file exports:

- `default function App()` — the component the dynamic route mounts.
- `export const meta = { label, createdAt }` — read by the `/apps`
  page to render the list and sort by recency.

Optional `meta` flag: `backgroundInput: true`. Apps stay mounted but
hidden for a while after the user navigates away; by default a hidden
app's window/document input listeners (keyboard, pointer, clipboard)
are gated off so it can't react to typing elsewhere. Set
`backgroundInput: true` only when the app must keep watching global
input while hidden (typing trackers, global-keybind launchers). The
flag affects input gating only, never teardown timing.

Then fill in the body. If you need a new dependency, `bun add <pkg>`
from the repo root (never `npm` or `pnpm`). Validate from the install
root:

```sh
node node_modules/typescript-7/lib/tsc.js -p desktop/tsconfig.app.json --noEmit
```

## One file, on purpose

Don't preemptively split. The agent should keep the whole app in one
file until it actually stops working — well past 1k lines, not before.
When it does, split helpers into siblings (`<slug>.helpers.ts`,
`<slug>.css`) and import them locally. The `/apps` page only needs the
top-level `<slug>.tsx` to keep exporting `default` and `meta`.

Don't touch:

- `desktop/src/routes/` — the dynamic `apps.$slug.tsx` route already
  resolves every user app.
- `desktop/src/app/_user/user-apps-registry.ts` — discovery happens
  through `import.meta.glob`; new files are picked up automatically.
- the left sidebar nav / `app-registry` — user apps live on the `/apps`
  page, reached via the sidebar's single "Apps" entry; they never get
  their own nav row.

## Visual style

You're designing a **page**, not a widget. The surface is the full
Stella canvas — `width: 100%; height: 100%`. Use the room. Don't cap
content to ~430px and float a single card in the middle of empty
space; that reads as a tiny modal lost on a desktop.

Aim for Apple-like polish: generous whitespace, restrained color,
sharp typography, intentional structure. **No AI slop**: don't pile
cards on cards, don't sprinkle gradients/badges/dots/emoji to fill
space, don't add affordances that aren't earned.

### Let the layout match the feature

The shape of the page should follow what's actually on it. A few
honest patterns — pick one, don't force it:

- **Hero + canvas** — a single focused surface (game board, viewer,
  editor): a Cormorant hero up top, then the thing itself filling the
  remaining height. The default stub is this shape.
- **Rail + canvas** — a comprehensive tool with controls plus a
  working area: `display: grid; grid-template-columns: <rail> 1fr;
  height: 100%`. Use this only when there are enough controls to earn
  a rail; don't manufacture a sidebar to look fancier.
- **Stream / list** — feeds, libraries, history: a hero, then a
  scrollable column at a comfortable measure (≤ ~72ch) inside the
  full-height surface.

What the patterns share: full-height layout, a real hero, structure
that fits the content. What they don't share: a fixed template.

### Typography

Type families are loaded globally via `desktop/src/main.tsx` — never
import or `@font-face` anything yourself, just reference the token:

- `var(--font-family-display)` — **Cormorant Garamond**. The page
  hero / title. Use 300 or 400 weight, tight letter-spacing (~ −0.04em),
  `line-height: 1`. Italics via `<em>` work well for a single accented
  word.
- `var(--font-family-sans)` — **Manrope**. Body, controls, labels.
  Set it on the root with
  `var(--font-family-sans--default-letter-spacing)` (−0.02em) so
  children inherit. Headings 600, body 400.
- `var(--font-family-mono)` — **IBM Plex Mono**. Numeric readouts,
  code/JSON, `<kbd>` chips, small uppercase tab labels. Pair with
  `font-variant-numeric: tabular-nums`.

### Color & surfaces

Don't hard-code colors — light/dark flip automatically through tokens.
**Don't paint a background on the root**; Stella's shifting gradient
canvas sits behind everything and the stub leaves the root transparent
on purpose. Apply backgrounds only on raised surfaces (rails, cards,
chips, modals) where contrast is actually needed.

- `var(--background)`, `var(--foreground)` — page bg / text
- `var(--card)` — raised surfaces
- `var(--border)` — hairlines
- `var(--accent)` — call-out / highlight color
- `var(--text-weaker, var(--muted-foreground))` — secondary text
- `var(--radius-2xl)` (12px), `var(--radius-full)` for pill chips
- `color-mix(in srgb, var(--foreground) 6%, transparent)` for
  theme-adaptive overlays

## Backlinks

- [stella-design](../stella-design/SKILL.md)
- [stella-desktop](../stella-desktop/SKILL.md)
