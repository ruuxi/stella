---
name: create-stella-app
description: Scaffold a new sidebar app inside Stella's desktop renderer in one shell call, then edit only the generated page.
---

# Adding a new sidebar app to Stella

Run the scaffold instead of writing the boilerplate by hand. The
Sidebar discovers new entries through `import.meta.glob`, the route
tree regenerates on save, and you're left with a typecheck-clean stub
to fill in.

## Scaffold

Run from the Stella install root (the directory containing `desktop/`,
`runtime/`, `state/`) so the script scaffolds into the tree the running
app loads from:

```sh
bun state/skills/create-stella-app/scripts/program.ts \
  <id> <label> [--slot top|bottom] [--order N] [--icon CustomXxx]
```

Defaults: `--slot top --order 50 --icon CustomLayout`. New apps sit
alongside Home in the top slot unless you opt out.

It creates these files (none of which already exist) and does nothing
else:

- `desktop/src/app/<id>/metadata.ts`
- `desktop/src/app/<id>/App.tsx`
- `desktop/src/app/<id>/<Component>View.tsx` ← fill this in
- `desktop/src/app/<id>/<id>.css`
- `desktop/src/routes/<id>.tsx`

`--icon` must be a name currently exported from
`desktop/src/shell/sidebar/SidebarIcons.tsx`; the script lists the
options if you pass an unknown one. Need a brand-new icon? Add the
SVG component there first, then re-run with `--icon Custom<Name>`.

After scaffolding, replace `<Component>View.tsx` with the real surface.
If you need a new package, run `bun add <pkg>` from the repo root (never
`npm` or `pnpm`). Then validate:

```sh
bunx --package typescript@6.0.3 tsc -p desktop/tsconfig.app.json --noEmit
bun run test:run -- tests/runtime/sidebar-discovery.test.ts tests/runtime/route-smoke.test.ts
```

## When to skip the scaffold

- Editing or extending an app that already exists.
- The app needs `hideFromSidebar: true` or `onActiveClick`. Scaffold
first, then tweak `metadata.ts`.

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
working area: `display: grid; grid-template-columns: <rail> 1fr; height: 100%`. Media Studio (`desktop/src/app/media/media-studio.css`,
~320px rail) is the reference. Use this only when there are
enough controls to earn a rail; don't manufacture a sidebar to
look fancier.
- **Stream / list** — feeds, libraries, history: a hero, then a
scrollable column at a comfortable measure (≤ ~72ch) inside the
full-height surface.

A small game and a comprehensive studio can both be beautiful pages.
What they share: full-height layout, a real hero, and structure that
fits the content. What they don't share: a fixed template.

### Typography

Type families are loaded globally via `desktop/src/main.tsx` — never
import or `@font-face` anything yourself, just reference the token:

- `var(--font-family-display)` — **Cormorant Garamond**. The page
hero / title. Set it on the `<h1>` (the stub already does). Use
300 or 400 weight, tight letter-spacing (~ −0.04em), `line-height: 1`. Italics via `<em>` work well for a single accented word.
- `var(--font-family-sans)` — **Manrope**. Body, controls, labels.
The stub's root rule sets this and
`var(--font-family-sans--default-letter-spacing)` (−0.02em) so
children inherit. Headings 600, body 400.
- `var(--font-family-mono)` — **IBM Plex Mono**. Numeric readouts,
code/JSON, `<kbd>` chips, small uppercase tab labels. Pair with
`font-variant-numeric: tabular-nums`.

### Color & surfaces

Don't hard-code colors — light/dark flip automatically through tokens.
**Don't paint a background on `.<id>-app`**; Stella's shifting
gradient canvas sits behind everything and the stub leaves the root
transparent on purpose. Apply backgrounds only on raised surfaces
(rails, cards, chips, modals) where contrast is actually needed.

- `var(--background)`, `var(--foreground)` — page bg / text
- `var(--card)` — raised surfaces
- `var(--border)` — hairlines
- `var(--accent)` — call-out / highlight color
- `var(--text-weaker, var(--muted-foreground))` — secondary text
- `var(--radius-2xl)` (12px), `var(--radius-full)` for pill chips
- `color-mix(in srgb, var(--foreground) 6%, transparent)` for
theme-adaptive overlays

## Backlinks

- [stella-desktop](../stella-desktop/SKILL.md)
