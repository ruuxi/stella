# Product UI

Use this for Stella desktop surfaces and any Stella-created app where users
are trying to complete a task: tools, settings, dashboards, editors, forms,
panels, sidebars, activity views, and operational screens.

## Standard

Product UI succeeds when a fluent user trusts it immediately. Familiarity is
often a feature. The failure mode is strangeness without purpose: mismatched
controls, over-decorated buttons, invented affordances, gratuitous motion, or
display typography where a label should be.

## Typography

- A single system or product sans family is often right.
- Use a tight scale, usually 1.125-1.2 between adjacent steps.
- Avoid fluid `clamp()` headings in dense product UI.
- Display fonts do not belong in buttons, labels, form controls, or data.

## Color

- Default to restrained color.
- Use tokens for backgrounds, borders, text, muted text, accents, and status.
- Accent color should mark selection, focus, primary action, or meaningful
  status.
- Inactive states should not use heavy saturation.
- Sidebars, toolbars, and panels may need a second neutral layer, but it
  should still come from the theme system.

## Layout

- Use predictable grids and alignment.
- Use established navigation patterns, tabs, forms, menus, and dialogs unless
  the task clearly needs something else.
- Density is allowed when the user needs comparison or repeated action.
- Responsive behavior should be structural: collapse, reflow, or switch
  layout. Do not just shrink text and hope it fits.

## Components

Every interactive component should have:

- Default.
- Hover.
- Focus-visible.
- Active.
- Disabled.
- Loading, when async.
- Error, when validation or failure is possible.
- Success, when completion needs confirmation.

Use skeletons for content loading when the layout is known. Avoid generic
spinners in the middle of otherwise structured content.

## Empty, Error, and Edge States

- Empty states should teach the next useful action.
- Error states should explain what happened and offer recovery.
- Long names, missing images, many items, zero items, slow network, and denied
  permissions should not break the layout.
- Use single-line truncation when a list row must keep stable height.

## Stella Fit

When modifying Stella itself:

- Match the canonical dialog, menu, toast, and pill-button language already in
  the app.
- Keep app-level dialogs app-level, not trapped inside scroll containers.
- Do not paint new route backgrounds when the global background should show.
- Keep display/sidebar controls pinned and stable.
- Preserve mini-window constraints; never let a full-window assumption leak
  into mini-only UI.
- Use normie-friendly labels in visible UI.

## Product Bans

- Decorative motion that does not convey state.
- Inconsistent button, menu, form, or dialog vocabulary across screens.
- Custom scrollbars or weird controls just for flavor.
- Heavy color on inactive elements.
- Full-page load choreography that delays a task surface.
