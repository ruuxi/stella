/**
 * Which right-button presses the radial dial declines to handle.
 *
 * The dial claims the right button across the whole shell surface, which would
 * otherwise swallow the one place a context menu genuinely earns its keep:
 * editable text, where right-click means cut/copy/paste. The composer opts out
 * explicitly through `data-composer-context-menu="native"`; every other
 * editable field is exempted by kind so a surface does not have to remember to
 * tag itself.
 *
 * Kept separate from the dial so the rule is unit-testable without a DOM
 * gesture, and so surfaces can consult it without importing the dial.
 */

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/** The composer's opt-out attribute, also honored by the native menu path. */
export const NATIVE_CONTEXT_MENU_SELECTOR =
  '[data-composer-context-menu="native"]';

export const isRadialGestureExempt = (target: EventTarget | null): boolean => {
  if (typeof Element === "undefined") return false;
  if (!(target instanceof Element)) return false;
  return (
    target.closest(NATIVE_CONTEXT_MENU_SELECTOR) !== null ||
    target.closest(EDITABLE_SELECTOR) !== null
  );
};
