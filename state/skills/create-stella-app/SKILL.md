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
bunx --package typescript@5.9.3 tsc -p desktop/tsconfig.app.json --noEmit
bun run test:run -- tests/runtime/sidebar-discovery.test.ts tests/runtime/route-smoke.test.ts
```

## When to skip the scaffold

- Editing or extending an app that already exists.
- The app needs `hideFromSidebar: true` or `onActiveClick`. Scaffold
first, then tweak `metadata.ts`.

## Visual style — reach for the existing tokens

Design with intent — Apple-like polish, generous whitespace, restrained
color, sharp typography. **No AI slop**: don't pile cards on cards,
don't sprinkle gradients/badges/dots/emoji to fill space, don't add
"smart" affordances that aren't earned. If the feature legitimately
calls for a different language (e.g. a game, a richly visual surface),
diverge intentionally — but the default is the rest of Stella.

**Don't paint a background on the root.** Stella's shifting gradient
canvas sits behind everything; setting `background:` on `.<id>-app`
covers it up. The stub leaves it transparent on purpose. Apply
backgrounds only on raised surfaces (cards, chips, modals) where
contrast is actually needed.

The stub already wires the right tokens. Keep using these so the new
surface reads like the rest of Stella in both themes:

- `var(--background)`, `var(--foreground)` — page bg / text
- `var(--card)` — raised surfaces
- `var(--border)` — hairlines
- `var(--accent)` — call-out / highlight color
- `var(--text-weaker, var(--muted-foreground))` — secondary text
- `var(--radius-2xl)` (12px), `var(--radius-full)` for pill chips
- `color-mix(in srgb, var(--foreground) 6%, transparent)` for theme-adaptive overlays

Type families are loaded globally via `desktop/src/main.tsx` — never
import or `@font-face` anything yourself, just reference the token:

- `var(--font-family-sans)` — **Manrope**. Default UI text. The stub's
root rule already sets this and `var(--font-family-sans--default-letter-spacing)`
(−0.02em) so children inherit. Headings 600, body 400.
- `var(--font-family-mono)` — **IBM Plex Mono**. Numeric readouts,
code/JSON, `<kbd>` chips. Pair with `font-variant-numeric: tabular-nums`.
- `var(--font-family-display)` — **Cormorant Garamond**. Hero/display
text only.

Don't hard-code colors. Light/dark theme flips automatically because
every token above flips.

Tag interactive UI with `data-stella-label`, `data-stella-state`,
`data-stella-action` so `stella-ui` can drive it without reading
component trees.

## Backlinks

- [stella-desktop](../stella-desktop/SKILL.md)

