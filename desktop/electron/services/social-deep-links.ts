// Classification for social/store deep links arriving through the OS
// protocol funnel (open-url / second-instance / cold-boot argv). Delegates
// to the shared renderer grammar (`src/shared/social/invite-links.ts`) so
// main can never divert a URL off the auth path that the renderer's
// SocialInviteLayer then silently drops. Kept free of electron imports so
// the routing rules are directly unit-testable.
//
// Recognized shapes (everything else stays untrusted and is dropped by the
// auth-service funnel):
//   stella://join/<inviteCode>            join a community
//   stella://add-friend/<username>        send a friend request
//   stella://store/<handle>/<packageId>   view a store add-on
//
// All three are *requests*, not actions: the renderer's SocialInviteLayer
// shows a confirmation dialog before anything happens.
import { parseSocialInviteLink } from "../../src/shared/social/invite-links.js";

/**
 * Whether `value` is a well-formed social/store deep link for the given
 * protocol (e.g. "stella"). True exactly when the renderer's
 * `parseSocialInviteLink` will accept the URL in its deep-link form.
 */
export const isSocialInviteDeepLink = (
  value: string,
  protocol: string,
): boolean => {
  // Only the deep-link form counts here — web-form invite links reaching
  // the protocol funnel are not protocol callbacks and stay untrusted.
  const prefix = `${protocol.toLowerCase()}://`;
  if (!value.trim().toLowerCase().startsWith(prefix)) return false;
  return parseSocialInviteLink(value, { deepLinkProtocol: protocol }) !== null;
};
