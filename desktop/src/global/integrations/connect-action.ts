/**
 * Shared "open Connect" action — opens the same URL-driven Connect dialog
 * (`?dialog=connect`) as the account menu, without each call site
 * re-implementing the router search navigation. `__root.tsx` listens for
 * `stella:open-connect` and funnels it through `showConnectDialog`.
 */

export const OPEN_CONNECT_DIALOG_EVENT = "stella:open-connect";

export const openConnectDialog = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_CONNECT_DIALOG_EVENT));
};
