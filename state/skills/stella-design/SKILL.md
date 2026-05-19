---
name: stella-design
description: Improve frontend UI quality for Stella desktop surfaces and Stella-created apps through product-aware layout, typography, theming, interaction states, responsive behavior, and visual polish.
---

# Stella Design

Use this when changing any frontend surface: Stella desktop routes,
dialogs, sidebars, onboarding, settings, inline artifacts, Store surfaces,
or apps created with [create-stella-app](../create-stella-app/SKILL.md).

This skill is agent-facing guidance. It does not add user commands, runtime
registries, or plugin surfaces. Read only the references needed for the
current design problem.

## First Move

Before editing UI:

1. Identify the surface:
   - **Stella product UI**: desktop app chrome, settings, Store, sidebar,
     composer, dialogs, task/activity surfaces. Use
     [product-ui.md](reference/product-ui.md).
   - **Stella-created app**: a user-facing app inside `desktop/src/app/*`.
     Use [product-ui.md](reference/product-ui.md) for tools and dashboards,
     or [brand-surface.md](reference/brand-surface.md) for marketing,
     editorial, portfolio, product showcase, venue, game intro, or any page
     where the design itself is the experience.
2. Read the nearby code before inventing a pattern. Reuse Stella tokens,
   shared components, icon families, dialog styling, button language, and
   route structure where they exist.
3. Write one sentence for the usage scene: who is using this, where, with
   what urgency, and what state of mind. Let that sentence choose density,
   contrast, motion, and theme, not a category reflex.
4. If scaffolding a new sidebar app, run the create-app scaffold first, then
   design inside the generated view.

## References

Pick the smallest set that fits the task:

- [visual-principles.md](reference/visual-principles.md) — shared rules:
  color, typography, layout, motion, copy, anti-slop checks.
- [typography-layout.md](reference/typography-layout.md) — type hierarchy,
  spacing rhythm, alignment, grids, density, and visual structure.
- [interaction-states.md](reference/interaction-states.md) — controls,
  forms, menus, dialogs, empty/error/loading states, and accessibility.
- [responsive-motion.md](reference/responsive-motion.md) — viewport behavior,
  touch targets, animation, transitions, reduced motion, and performance.
- [product-ui.md](reference/product-ui.md) — task-focused UI, desktop app
  surfaces, controls, states, density, settings, dashboards.
- [brand-surface.md](reference/brand-surface.md) — landing pages, portfolio,
  marketing, showcases, visual-first apps, image-led surfaces.
- [quality-pass.md](reference/quality-pass.md) — audit and polish checklist
  before declaring UI work complete.

## Stella Defaults

- Stella desktop surfaces are product UI unless the route is explicitly a
  showcase, marketing surface, or immersive app.
- Prefer quiet, useful, spacious UI. Let the task lead. Do not fill empty
  space with repeated cards, badges, dots, gradients, or decorative motion.
- Use Stella theme tokens and existing CSS variables. Do not hard-code colors
  for surfaces that need to survive theme changes.
- Use the app's established icon set and component vocabulary. Do not mix icon
  families or invent a different button language for a single screen.
- In app pages, use the full canvas. Avoid tiny centered modal-like pages
  inside a desktop surface.
- Use human copy. Avoid exposed AI terminology, technical jargon for normal
  users, em dashes, and decorative wording that repeats the heading.

## Build Bar

A frontend change is not done until it works as an interface, not just as a
static screenshot:

- Default, hover, focus-visible, active, disabled, loading, empty, error, and
  long-content states are covered when relevant.
- Keyboard paths and accessible names exist for controls.
- Text fits on narrow and wide viewports without overlap.
- Motion communicates state and respects reduced motion.
- The surface still fits Stella's product system after the change.
- Validation matches the scope. For desktop renderer work, run:

```sh
bunx tsgo -p desktop/tsconfig.app.json --noEmit
```

For broader desktop changes, also run the validation listed in
[stella-desktop](../stella-desktop/SKILL.md).

## When Creating Apps

For a brand-new Stella app:

1. Use [create-stella-app](../create-stella-app/SKILL.md) for the shell.
2. Decide whether the app is a **task tool** or a **visual-first
   experience**.
3. Read this skill plus the relevant reference files.
4. Build the generated view as a complete page, not a tiny widget.
5. Inspect the page visually at the app's normal desktop size and at a narrow
   size before finishing.

For games, studios, editors, dashboards, galleries, and creative tools, the
page should feel like the real app surface immediately. Do not ship a
marketing page explaining the app instead of the app.

## Attribution

This skill adapts selected ideas from the Apache-2.0 Impeccable design skill
by Paul Bakaus, with Stella-specific command, runtime, and product guidance
removed.

## Backlinks

- [create-stella-app](../create-stella-app/SKILL.md)
- [stella-desktop](../stella-desktop/SKILL.md)
