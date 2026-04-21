/**
 * Sticky module-level state for the Google Workspace "auth required" signal.
 *
 * The IPC channel `googleWorkspace:authRequired` is fire-and-forget from main:
 * if no renderer-side listener is mounted at fire time, the prompt is silently
 * dropped. Previously the listener lived inside `ConversationEvents`, so it
 * only existed while the user was looking at a conversation with messages.
 * Background / sidebar agent runs that needed Google auth would never surface
 * the connect card.
 *
 * This module flips the listener mount point to the app root (eager) and
 * persists the "needs connect" flag here until any consumer acknowledges it,
 * so the connect card can pop the next time a chat surface mounts even if it
 * wasn't mounted when the IPC arrived.
 */

let authRequiredFlag = false;
const subscribers = new Set<() => void>();

const notify = () => {
  for (const cb of subscribers) {
    cb();
  }
};

export const subscribeGoogleWorkspaceAuthRequired = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

export const getGoogleWorkspaceAuthRequired = (): boolean => authRequiredFlag;

export const setGoogleWorkspaceAuthRequired = () => {
  if (authRequiredFlag) return;
  authRequiredFlag = true;
  notify();
};

export const acknowledgeGoogleWorkspaceAuthRequired = () => {
  if (!authRequiredFlag) return;
  authRequiredFlag = false;
  notify();
};
