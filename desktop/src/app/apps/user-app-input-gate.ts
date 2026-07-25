import { getUserApp } from "@/app/_user/user-apps-registry";

/**
 * Global-input gate for keep-alive user apps.
 *
 * `<PersistentUserAppsHost />` keeps user apps mounted-but-hidden after the
 * user leaves them. `inert` + `visibility: hidden` stop events *targeted
 * at the app's subtree*, but apps also register window/document-level
 * listeners (Tower Reader binds "j"/"f" on `window`), and those keep firing
 * while the app is hidden — swallowing keystrokes typed into chat.
 *
 * This module patches `addEventListener`/`removeEventListener` on `window`
 * and `document` (only — element listeners inside app subtrees are already
 * neutralized by inert/visibility). When a *global input* event type is
 * registered and the registration call stack contains a user-app module
 * frame (`desktop/src/app/_user/<slug>.tsx`, including `<slug>.*.ts(x)`
 * helper splits), the listener is wrapped so it no-ops unless that app is
 * the one on screen (see `onScreenUserAppSlug`, which the host feeds in).
 *
 * Per-app opt-out of the gating (NOT of teardown): a user app may export
 * `meta = { label, createdAt, backgroundInput: true }`. With
 * `backgroundInput: true` its global input listeners stay live while the
 * app is retained-hidden — for apps that legitimately watch input in the
 * background (typing trackers, global-keybind launchers). The flag changes
 * input gating only; teardown timing and retention slots are unaffected,
 * and a torn-down app loses its listeners through normal unmount cleanup.
 *
 * Attribution is call-stack based, so it covers listeners added at mount,
 * from later effects, and from timeouts/promises whose callbacks are
 * defined in the app module. It cannot attribute registrations that reach
 * `addEventListener` without any app-module frame on the stack (e.g. the
 * app hands a shell-defined helper a config object and the helper registers
 * later from its own scheduling); such listeners simply keep today's
 * ungated behavior. Shell/chat listeners never carry a `_user` frame and
 * are never touched.
 */

/**
 * Event types treated as "global input": keyboard and the other
 * user-input families a hidden app must not react to. Lifecycle-ish events
 * (focus/blur, resize, scroll, visibilitychange, fullscreenchange) are
 * deliberately not gated.
 */
const GATED_INPUT_EVENT_TYPES = new Set([
  // Keyboard & IME composition
  "keydown",
  "keypress",
  "keyup",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  // Text input & clipboard & selection
  "beforeinput",
  "input",
  "change",
  "copy",
  "cut",
  "paste",
  "selectionchange",
  // Pointer / mouse / touch / wheel
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "wheel",
]);

type GateSharedState = {
  /** Slug of the user app the panel is currently showing, or null. */
  activeInputSlug: string | null;
  /** Idempotency marker so HMR re-evaluation never double-patches. */
  installed: boolean;
};

/**
 * Shared mutable state lives on `globalThis` under a well-known symbol so
 * that wrappers created by an older HMR generation of this module keep
 * reading the same active-slug value newer generations write.
 */
const GATE_STATE_KEY = Symbol.for("stella.user-app-input-gate");

const getSharedState = (): GateSharedState => {
  const holder = globalThis as unknown as Record<
    symbol,
    GateSharedState | undefined
  >;
  let state = holder[GATE_STATE_KEY];
  if (!state) {
    state = { activeInputSlug: null, installed: false };
    holder[GATE_STATE_KEY] = state;
  }
  return state;
};

/** Called by the keep-alive host whenever the visible user app changes. */
export const setInputActiveUserApp = (slug: string | null): void => {
  getSharedState().activeInputSlug = slug;
};

/**
 * Keyboard events go wherever focus is, regardless of what the pointer is
 * over, so they are the only family whose target is ambiguous between an
 * on-screen app and the rest of the shell. Everything else the gate covers is
 * already aimed by the browser at whatever the user is actually over or in.
 */
const FOCUS_SENSITIVE_EVENT_TYPES = new Set([
  "keydown",
  "keypress",
  "keyup",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "beforeinput",
]);

/**
 * Whether keyboard focus is somewhere the on-screen app should answer for.
 *
 * Being visible is not enough. An app renders *beside* the chat surface rather
 * than in place of it, so the user can be typing a message while the app is
 * fully on screen — and an app that binds bare letters to `window` would eat
 * those keystrokes. Focus inside the app's own surface means the keys are
 * meant for it; focus nowhere in particular (`body`, after a click on empty
 * chrome) still counts, because that is the state an app's global shortcuts
 * are written for.
 */
const isFocusInsideActiveUserApp = (): boolean => {
  if (typeof document === "undefined") return true;
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return active.closest(".persistent-user-app-surface--active") !== null;
};

/**
 * Checked at dispatch time (not registration time) so section changes, focus
 * moves and HMR edits to an app's `meta.backgroundInput` all take effect
 * immediately.
 */
const isUserAppInputLive = (slug: string, type: string): boolean => {
  if (getUserApp(slug)?.meta.backgroundInput === true) return true;
  if (getSharedState().activeInputSlug !== slug) return false;
  return FOCUS_SENSITIVE_EVENT_TYPES.has(type)
    ? isFocusInsideActiveUserApp()
    : true;
};

const USER_APP_FRAME = /\/app\/_user\/([A-Za-z0-9._-]+)\.tsx?\b/;

/**
 * Attribute an `addEventListener` call to a user app by scanning the call
 * stack for a `_user` module frame. Validated against the registry so
 * infrastructure files in `_user` (`user-apps-registry.ts`,
 * `new-user-apps-hint.ts`) can never be misattributed — an unregistered
 * name means "not a user app" and the listener is left untouched.
 */
const ownerUserAppSlug = (): string | null => {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = previousLimit;
  const match = USER_APP_FRAME.exec(stack);
  if (!match || !match[1]) return null;
  const base = match[1];
  if (getUserApp(base)) return base;
  // Helper splits like `<slug>.helpers.ts` attribute to `<slug>`.
  const primary = base.split(".")[0];
  if (primary && getUserApp(primary)) return primary;
  return null;
};

const usesCapture = (options?: boolean | AddEventListenerOptions): boolean =>
  options === true ||
  (typeof options === "object" && options !== null && options.capture === true);

const patchGlobalTarget = (target: EventTarget): void => {
  const nativeAdd = target.addEventListener.bind(target);
  const nativeRemove = target.removeEventListener.bind(target);
  // Wrapper identity map mirroring the platform's (type, listener, capture)
  // dedupe key, so re-adds dedupe and `removeEventListener` with the
  // original listener removes the wrapper we actually registered.
  const wrappersByKey = new Map<
    string,
    WeakMap<EventListenerOrEventListenerObject, EventListener>
  >();

  const wrapperFor = (
    slug: string,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): EventListener => {
    const key = `${type}|${usesCapture(options) ? "c" : "b"}`;
    let byListener = wrappersByKey.get(key);
    if (!byListener) {
      byListener = new WeakMap();
      wrappersByKey.set(key, byListener);
    }
    let wrapper = byListener.get(listener);
    if (!wrapper) {
      wrapper = (event: Event): void => {
        if (!isUserAppInputLive(slug, event.type)) return;
        if (typeof listener === "function") listener.call(target, event);
        else listener.handleEvent(event);
      };
      byListener.set(listener, wrapper);
    }
    return wrapper;
  };

  const gatedAdd = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    if (listener && GATED_INPUT_EVENT_TYPES.has(type)) {
      const slug = ownerUserAppSlug();
      if (slug) {
        nativeAdd(type, wrapperFor(slug, type, listener, options), options);
        return;
      }
    }
    nativeAdd(type, listener, options);
  };

  const gatedRemove = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void => {
    if (listener && GATED_INPUT_EVENT_TYPES.has(type)) {
      const key = `${type}|${usesCapture(options) ? "c" : "b"}`;
      const byListener = wrappersByKey.get(key);
      const wrapper = byListener?.get(listener);
      if (wrapper) {
        nativeRemove(type, wrapper, options);
        byListener?.delete(listener);
      }
    }
    // Always also remove the raw listener: exact-match removal is a no-op
    // when it was never registered natively, so this is safe either way.
    nativeRemove(type, listener, options);
  };

  Object.defineProperty(target, "addEventListener", {
    value: gatedAdd,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(target, "removeEventListener", {
    value: gatedRemove,
    configurable: true,
    writable: true,
  });
};

/**
 * Install the gate once per renderer. Idempotent across HMR generations.
 * Called at module scope by `PersistentUserAppsHost`, which always loads
 * before any user app module can run (apps are lazy children of the host).
 */
export const installUserAppInputGate = (): void => {
  if (typeof window === "undefined") return;
  const state = getSharedState();
  if (state.installed) return;
  state.installed = true;
  patchGlobalTarget(window);
  patchGlobalTarget(document);
};
