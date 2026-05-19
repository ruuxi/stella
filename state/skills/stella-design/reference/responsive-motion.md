# Responsive Behavior And Motion

Use this for viewport adaptation, mini-window constraints, animation,
transition quality, performance, and reduced-motion behavior.

## Responsive Principle

Responsive design is not shrinking. It is choosing a different structure when
the available space changes.

Before writing breakpoints, identify what must stay visible:

- Primary action.
- Current selection or state.
- Content being edited or inspected.
- Navigation needed to recover.
- Safety controls such as close, cancel, or stop.

Everything else can move, collapse, summarize, or hide behind progressive
disclosure.

## Breakpoint Strategy

- Start from the real containers Stella uses, not generic device names.
- Test the full window, mini window where relevant, and one narrow width.
- Collapse side-by-side layouts into stacked or tabbed layouts when needed.
- Keep controls near the content they affect.
- Avoid horizontal scroll except for deliberate tab strips, timelines, or data
  tables where horizontal comparison is the point.
- Keep close/fullscreen/safety controls pinned and unobstructed.

## Touch And Pointer Targets

- Touch targets should generally be at least 44x44px.
- Dense desktop controls can be smaller only when pointer precision is
  expected and the local app pattern supports it.
- Drag handles need enough hit area.
- If an iframe or canvas can intercept pointer events, account for resizing
  and overlay interactions explicitly.

## Text And Overflow

- Long labels should truncate, wrap, or reflow intentionally.
- Single-line rows should use ellipsis and stable row height.
- Buttons should not grow unpredictably on hover or loading.
- Counters, timers, and numeric values should use tabular numerals when they
  update.
- Do not let text overlap icons, controls, or subsequent content.

## Motion Purpose

Use motion for:

- Revealing new UI.
- Showing selection or focus changes.
- Confirming action feedback.
- Communicating progress.
- Maintaining spatial continuity.
- Adding atmosphere in brand/showcase surfaces.

Do not use motion as decoration in task-heavy product UI.

## Timing And Easing

- Most product transitions: 150-250ms.
- Larger panel or route transitions: 200-350ms when they preserve spatial
  continuity.
- Use ease-out curves that settle cleanly.
- Avoid bounce and elastic easing.
- Staggered choreography belongs mostly to onboarding or brand/showcase
  surfaces, not routine product screens.

## Performance

- Prefer transform and opacity for frequent animation.
- Avoid animating width, height, top, left, or layout-heavy properties unless
  the element is isolated and measured.
- Bound expensive blur, filter, shadow, and backdrop effects.
- Use `will-change` sparingly and remove it when no longer needed.
- Avoid polling-driven visual reorder or animation churn.
- Keep canvas/WebGL scenes visibly nonblank, correctly framed, and responsive.

## Reduced Motion

Respect `prefers-reduced-motion`:

- Remove nonessential choreography.
- Keep essential state changes but make them shorter or non-spatial.
- Avoid parallax, large zooms, or sweeping transitions for reduced-motion
  users.

## Stella-Specific Responsive Notes

- Mini-window UI has different constraints from the full window. Do not assume
  full-window sidebars or panels fit there.
- The display sidebar can cover meaningful content if opened in cramped
  contexts; keep controls stable and respect existing open/close rules.
- Native top-bar controls and Stella shell controls must not overlap route UI.
- Onboarding and overlay flows should avoid layout shift between phases.

## Motion Bans

- Animating layout by accident.
- Hover states that move neighboring content.
- Long transitions that delay repeated work.
- Decorative loops in dense product surfaces.
- Page-load choreography for routine settings or dashboards.
- Ignoring reduced motion.
