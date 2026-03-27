/** Module-level callback so _layout.tsx can trigger stella.tsx's refresh. */
let _fn: (() => void) | null = null;
export const registerStellaRefresh = (fn: (() => void) | null) => {
  _fn = fn;
};
export const triggerStellaRefresh = () => _fn?.();
