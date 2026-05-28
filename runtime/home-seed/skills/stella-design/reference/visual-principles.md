# Visual Principles

These rules apply to both Stella product UI and visual-first app surfaces.
Use them as a design review lens before and after implementation.

## Color

- Choose a color strategy before choosing colors:
  - **Restrained**: tinted neutrals plus one accent. Default for product UI.
  - **Committed**: one strong color carries a major part of the surface.
  - **Full palette**: three or four deliberate color roles.
  - **Drenched**: color is the atmosphere of the whole surface.
- Avoid pure `#000` and `#fff` when defining new colors. Use theme tokens
  first; if new values are truly needed, use subtly tinted neutrals.
- Accent color is not decoration. In product UI it should mean primary
  action, selected state, focus, or meaningful status.
- Do not ship a one-note palette where the whole screen is just variants of
  one fashionable hue.

## Theme

Dark and light are not default answers. Pick based on the usage scene:
ambient light, urgency, task duration, and the user's focus. Stella surfaces
must respect the active theme unless they are intentionally immersive.

## Typography

- Product UI usually wants one excellent sans family, tight hierarchy, and
  stable rem sizes.
- Brand or showcase surfaces can use stronger display type, but the type must
  match the subject, not a generic "designed" look.
- Keep body measure readable, typically 65-75 characters for prose.
- Use scale and weight for hierarchy. Avoid flat type where headings, labels,
  and body all feel the same.
- Do not scale UI font size with viewport width.

## Layout

- Cards are not the default layout. Use them when they frame repeated items,
  a modal, or a genuinely bounded tool.
- Never nest cards inside cards.
- Do not wrap everything in a centered max-width container by reflex. Most
  Stella surfaces are desktop canvases with room for structure.
- Vary spacing for rhythm. Identical padding everywhere reads mechanical.
- Use stable dimensions for toolbars, boards, grids, counters, buttons, and
  tiles so hover states and dynamic labels do not shift layout.

## Motion

- Motion should explain state: reveal, feedback, loading, selection,
  completion, or transition.
- Product UI transitions should usually be short, around 150-250ms.
- Avoid bounce and elastic easing.
- Do not animate expensive layout properties casually.
- Respect `prefers-reduced-motion`.

## Copy

- Every word should earn its place.
- Do not restate a heading in the paragraph below it.
- Avoid em dashes.
- Avoid user-facing AI jargon such as "text-to-image" or "image-to-image";
  use normal words like photo, edit, animate, or generate when needed.
- Prefer friendly nouns users already understand.

## Absolute Bans

Rewrite the element if you are about to add:

- Gradient text.
- Decorative glassmorphism as a default surface treatment.
- Side-stripe borders thicker than 1px as a card/list accent.
- Identical icon-heading-text card grids used as filler.
- Hero metric templates with big number, small label, supporting stats, and
  gradient accent.
- A modal as the first idea when inline, page-level, or progressive disclosure
  would fit better.

## Anti-Slop Check

Run the category-reflex test twice:

1. Could someone guess the palette and theme from the category alone?
   Examples: finance becomes navy and gold, healthcare becomes white and teal,
   observability becomes dark blue.
2. Could someone guess the aesthetic from category plus anti-reference?
   Example: an AI tool that avoids SaaS cream becomes editorial serif plus
   mono labels.

If either answer is yes, make the usage scene more specific and redesign from
that scene.
