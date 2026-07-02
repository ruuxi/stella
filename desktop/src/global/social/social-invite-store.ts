import { useSyncExternalStore } from "react";
import type { SocialInvite } from "@/app/social/invite-links";

/**
 * Single pending social invite awaiting user confirmation.
 *
 * Two producers feed it: the OS deep-link path (`SocialInviteLayer`'s IPC
 * subscription) and in-app invite cards in social chat. One consumer — the
 * confirmation dialog rendered by `SocialInviteLayer` — clears it on
 * dismiss/confirm. Deliberately module-level (not React context): invite
 * clicks can originate outside the router tree (cold boot, chat cards).
 */
let pendingInvite: SocialInvite | null = null;
const listeners = new Set<() => void>();

export const setPendingSocialInvite = (invite: SocialInvite | null) => {
  pendingInvite = invite;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => pendingInvite;

export const usePendingSocialInvite = () =>
  useSyncExternalStore(subscribe, getSnapshot);
