// Pure classification for social/store deep links arriving through the OS
// protocol funnel (open-url / second-instance / cold-boot argv). Kept free
// of electron imports so the routing rules are directly unit-testable.
//
// Recognized shapes (everything else stays untrusted and is dropped by the
// auth-service funnel):
//   stella://join/<inviteCode>            join a community
//   stella://add-friend/<username>        send a friend request
//   stella://store/<handle>/<packageId>   view a store add-on
//
// All three are *requests*, not actions: the renderer's SocialInviteLayer
// shows a confirmation dialog before anything happens.

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Matches the share-link packageId shape (`features/store/share-link.ts`):
// dots allowed, same bounds.
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const pathSegments = (parsed: URL): string[] =>
  parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

/**
 * Whether `value` is a well-formed social/store deep link for the given
 * protocol (e.g. "stella"). Strictly shaped: known hostname keyword plus
 * exactly the expected identifier segments.
 */
export const isSocialInviteDeepLink = (
  value: string,
  protocol: string,
): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol.toLowerCase() !== `${protocol.toLowerCase()}:`) {
    return false;
  }
  const host = parsed.hostname.trim().toLowerCase();
  const segments = pathSegments(parsed);

  if (host === "join" || host === "add-friend") {
    return segments.length === 1 && IDENTIFIER_PATTERN.test(segments[0]!);
  }
  if (host === "store") {
    return (
      segments.length === 2 &&
      IDENTIFIER_PATTERN.test(segments[0]!) &&
      PACKAGE_ID_PATTERN.test(segments[1]!)
    );
  }
  return false;
};
