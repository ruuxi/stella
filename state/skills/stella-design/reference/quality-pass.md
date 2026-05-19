# Quality Pass

Use this before finishing frontend work. The goal is to catch concrete defects
and design drift, not to create a long theoretical review.

## Design System Discovery

Before polishing:

1. Find the local pattern: shared components, CSS variables, tokens,
   neighboring screens, route layout, dialog/menu/toast style, icon set.
2. Note conventions: spacing, button shape, typography, surface elevation,
   focus rings, menu behavior, loading states, and responsive breakpoints.
3. Classify drift:
   - **Missing token**: the value should exist but does not.
   - **One-off implementation**: a shared component or pattern already exists.
   - **Conceptual mismatch**: the flow or hierarchy does not match adjacent
     features.

Fix the cause, not just the symptom.

## Technical Audit

Check five dimensions:

- **Accessibility**: contrast, labels, keyboard navigation, focus indicators,
  semantic headings, landmarks, alt text, form errors.
- **Performance**: expensive layout reads/writes, animation jank, oversized
  assets, unnecessary imports, avoidable re-renders.
- **Theming**: token use, dark/light behavior, status colors, contrast after
  theme changes.
- **Responsive behavior**: narrow viewport, touch targets, horizontal scroll,
  long text, variable content count.
- **Anti-patterns**: gradient text, nested cards, decorative glass,
  identical card grids, category-reflex palette, redundant copy.

## Interaction Checklist

For every control, verify relevant states:

- Default.
- Hover.
- Focus-visible.
- Active.
- Disabled.
- Loading.
- Error.
- Success.

Also check:

- Keyboard-only path.
- Escape/cancel behavior.
- Click outside behavior for popovers and dialogs.
- Long labels.
- Empty and many-item states.
- Reduced motion.

## Visual Checklist

- Alignment is deliberate at desktop and narrow widths.
- Spacing follows a visible rhythm rather than random one-off gaps.
- Text does not overlap or overflow its container.
- Icons are optically centered and from one family.
- The hierarchy is clear when squinting.
- Important actions are visible but not shouting.
- Secondary text is readable, not washed out.
- The surface still feels like Stella unless it is intentionally a separate
  app experience.

## Review Output

When reporting a design pass, be concrete:

- Name the surface reviewed.
- State whether it is product UI or brand/showcase.
- List the real issues found, ordered by user impact.
- Separate functional defects from visual polish.
- Name any design-system drift and whether it is token, component, or concept
  drift.
- Keep P3 polish issues sparse. Too many tiny issues hide the important ones.

Useful severity framing:

- **P0**: blocks task completion or ships broken UI.
- **P1**: major confusion, accessibility failure, or broken responsive path.
- **P2**: noticeable friction with a workaround.
- **P3**: refinement with limited user impact.

## Polish Priorities

If time is limited, fix in this order:

1. Broken interaction paths.
2. Accessibility and keyboard failures.
3. Responsive overflow or overlap.
4. Error, empty, and loading states.
5. Design-system drift.
6. Visual rhythm, alignment, and type details.
7. Delight and atmosphere.

## Verification

Use the strongest practical verification for the scope:

- Renderer typecheck:

```sh
bunx tsgo -p desktop/tsconfig.app.json --noEmit
```

- Broader desktop change: also use the checks in
  [stella-desktop](../../stella-desktop/SKILL.md).
- Visual work: inspect the running UI or screenshots at the main viewport and
  at least one narrow viewport.

Do not treat a clean automated check as proof that the design is good. It only
means the specific automated check passed.
