# Typography And Layout

Use this when the surface feels generic, cramped, flat, misaligned, or
template-like. Type and space carry most of the perceived quality.

## Typography Procedure

Before changing font sizes or families:

1. Identify the register: product UI or brand/showcase.
2. Identify the user's task and reading mode: scan, compare, edit, browse,
   decide, or linger.
3. Find nearby type conventions in Stella or the generated app.
4. Choose hierarchy by role, not by what "looks nice" in isolation.

Product UI usually wants a single sans family, restrained scale, strong label
clarity, and stable line height. Brand/showcase surfaces can take more risk,
but the choice must match the subject and audience.

## Hierarchy

- Use size, weight, spacing, and placement together. Do not rely on color
  alone.
- A heading should clearly own the content below it.
- Labels should be smaller and calmer than the values they describe.
- Metadata should be readable but visually secondary.
- Important actions need proximity and contrast, not decorative treatment.
- Avoid four same-weight headings stacked together. That is not hierarchy.

## Scale

- Product UI: keep ratios tight, generally 1.125-1.2 between steps.
- Brand/showcase: use stronger contrast where the page benefits from drama.
- Body prose should usually sit around 65-75 characters per line.
- Compact controls can be denser, but minimum readable text should stay
  practical on the target viewport.
- Avoid viewport-width font sizing. It creates unpredictable UI.

## Line Height And Letter Spacing

- Body copy needs enough line height to read without touching adjacent lines.
- Small uppercase labels should be short and used sparingly.
- Avoid negative letter spacing in UI controls.
- If using display text, adjust line height intentionally. Big type often
  needs tighter leading, while light text on dark backgrounds often needs more
  breathing room.

## Layout Diagnosis

Name the actual layout problem before editing:

- **Weak hierarchy**: the eye does not know where to begin.
- **Monotone spacing**: every gap is the same, so nothing groups.
- **Over-containering**: everything sits in boxes, cards, or max-width wrappers.
- **Under-structure**: content floats without alignment, rhythm, or clear
  zones.
- **Wrong density**: the screen is either too sparse for repeated work or too
  packed for comprehension.
- **Template reflex**: centered hero, three cards, generic stats, repeated
  icon headings.

Fix structure first. Color and shadows cannot rescue a bad layout.

## Spatial Rules

- Use a real grid or real asymmetry. Do not split the difference accidentally.
- Align edges. Optical alignment matters as much as mathematical alignment.
- Group related controls through proximity before drawing boxes around them.
- Let high-importance elements breathe.
- Keep repeated rows stable in height unless the content genuinely needs more
  space.
- Reserve hero-scale type for real heroes. Compact panels and sidebars need
  compact headings.
- Do not create page sections as floating cards. Use full-width bands,
  unframed layouts, or repeated item cards where appropriate.

## Stella Page Shapes

Common useful shapes:

- **Hero plus canvas**: title/summary area followed by the main working or
  visual surface.
- **Rail plus canvas**: controls on one side, live output or workspace on the
  other.
- **Toolbar plus workspace**: compact controls above a dense editor, board, or
  table.
- **Stream/list**: a constrained reading column or stable row list.
- **Split inspector**: primary content plus a secondary details panel.

Choose the shape from the workflow. Do not add a rail, hero, or card grid just
to make the page look designed.

## Alignment Checks

Before finishing, look for:

- Button text vertically centered with icons.
- Icons optically centered in square buttons.
- Form labels aligned consistently.
- Card/list edges lining up across rows.
- Sidebar and top-bar content respecting existing Stella chrome.
- No text touching container edges.
- No hover/focus state changing dimensions.

## Layout Bans

- A small card centered in an otherwise empty desktop canvas.
- Nested cards.
- Same-size cards repeated because the content had no structure.
- Arbitrary one-off gaps like 13px or 27px without a reason.
- Full-width prose that becomes hard to read.
- Tiny controls stranded far from the thing they affect.
