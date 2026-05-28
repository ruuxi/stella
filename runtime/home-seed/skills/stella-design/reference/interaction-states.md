# Interaction And States

Use this when building controls, forms, dialogs, menus, onboarding, settings,
sidebars, editors, or any surface where the user takes action.

## Interaction Standard

An interface is only designed when the interaction path is designed. A pretty
static layout with missing hover, focus, loading, error, empty, and edge states
is unfinished.

## Control Vocabulary

Reuse the local vocabulary first:

- Existing Stella buttons and pill button variants.
- Existing Radix/menu/dialog styling where present.
- Existing icon library and sizes.
- Existing form controls and focus treatments.
- Existing toast, confirmation, and app-level dialog patterns.

Do not invent a new button shape, menu style, or modal treatment for one
screen unless the existing system cannot support the interaction.

## Required States

For every interactive component, decide which states apply:

- **Default**: resting, readable, clearly interactive.
- **Hover**: subtle feedback that does not shift layout.
- **Focus-visible**: keyboard focus is visible and high contrast.
- **Active**: press/click feedback.
- **Selected/current**: distinct from hover.
- **Disabled**: visibly unavailable and semantically disabled.
- **Loading**: action is underway, duplicate action prevented when needed.
- **Error**: what failed and how to recover.
- **Success**: confirmation only where users need it.

Missing focus and disabled states are common defects, not polish.

## Forms

- Every input needs a label or accessible name.
- Required fields should be clear without relying only on color.
- Validation should happen at a useful time: on blur for local format issues,
  on submit for whole-form issues, inline for immediate constraints.
- Error copy should say what went wrong and what to do next.
- Help text should be near the field it explains.
- Preserve typed content when errors happen.
- Avoid large forms when progressive disclosure would reduce cognitive load.

## Menus And Popovers

- Trigger, menu, and selected value should form one clear mental model.
- Menus should auto-place where they fit when the app already uses that
  pattern.
- Keyboard navigation and Escape should work.
- Clicking outside should close without surprising focus jumps.
- Menu items should be verbs for commands and nouns for choices.
- Avoid huge ungrouped menus. Add search, grouping, or progressive disclosure.

## Dialogs

Use dialogs for confirmation, interruption, or focused short tasks. Do not use
one because routing or inline UI was inconvenient.

A good dialog has:

- One clear purpose.
- A title that names the decision or task.
- Body copy that adds information, not restates the title.
- Primary and secondary actions with clear order.
- Escape/cancel behavior.
- Focus trapping and restoration.
- App-level placement when the action concerns the whole app.

## Loading

- Use skeletons when layout is known.
- Use inline progress when a single action is running.
- Use toasts or status rows for background work.
- Keep previous content visible when refreshing if it is still valid.
- Avoid blanking the whole surface unless the old content is dangerous or
  misleading.

## Empty States

An empty state should answer:

- What belongs here?
- Why is it empty?
- What can I do next?

Keep it short. Do not turn empty states into marketing panels. For Stella,
prefer practical next actions and friendly labels.

## Error States

Errors need recovery paths:

- Retry when the failure may be transient.
- Connect/sign in when credentials are missing.
- Edit input when validation failed.
- Open settings when configuration blocks the action.
- Keep a technical detail affordance only when useful for debugging.

Do not expose raw internal jargon as the main user-facing message.

## Accessibility

- Use buttons for actions and links for navigation.
- Preserve heading order.
- Give icon-only buttons accessible names.
- Keep target sizes practical, especially in mini-window or narrow surfaces.
- Do not remove focus outlines without a replacement.
- Do not rely on hover-only functionality.
- Use `aria-expanded`, `aria-selected`, `aria-current`, or `aria-invalid`
  where the component semantics require them.

## Cognitive Load

Reduce load by:

- Grouping related controls.
- Revealing advanced options only when needed.
- Keeping terminology consistent.
- Putting actions near the object they affect.
- Showing the current state clearly.
- Avoiding duplicate ways to do the same thing unless one is a true shortcut.

## Interaction Bans

- Disabled-looking controls that are clickable.
- Clickable rows with hidden or unclear affordance.
- Icon-only controls with no accessible name or tooltip where meaning is not
  obvious.
- Confirmation dialogs for low-risk reversible actions.
- Destructive actions without clear consequence and recovery.
- Hover-only critical actions.
