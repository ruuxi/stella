// Social invite links: join-a-community, add-a-friend, view-a-store-add-on.
//
// Two equivalent forms per social invite:
//   - Deep link:  stella://join/<CODE>            stella://add-friend/<username>
//   - Web link:   https://stella.sh/join/<CODE>   https://stella.sh/add-friend/<username>
//
// The web form is what users copy/share: it is clickable everywhere
// (iMessage, Discord, email), and the stella.sh page forwards to the deep
// link with an "Open in Stella" fallback — same pattern as the auth
// callback handoff page. The desktop app treats both forms identically:
// pasted as an entire chat message they render as an invite card, and the
// deep-link form arriving via the OS protocol handler opens the same
// confirmation dialog.
//
// This module is the ONE definition of the accepted link grammar. It is
// pure (no imports) so both the renderer and the electron main process
// (`electron/services/social-deep-links.ts`) parse identically — main must
// never divert a URL off the auth path that the renderer then drops.
// `features/store/share-link.ts` delegates its store-link parsing here too.
//
// Parsing is anchored to the whole message body — mid-sentence links
// intentionally don't trigger card embeds.

const WEB_HOST = "stella.sh";

const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]{8,9}$/;
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Mirrors the server-side `normalizePackageId` shape (dots allowed). We
// accept uppercase/mixed case when parsing so a hand-typed link still
// resolves; identifiers are lowercased on the way out.
export const PACKAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// Cheap reject before the throwing URL constructor: chat render paths run
// this on every message body, and `new URL("plain text")` throws.
const HAS_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export type SocialInvite =
  | { kind: "join-community"; inviteCode: string }
  | { kind: "add-friend"; username: string }
  /**
   * Externally-arriving `stella://store/<handle>/<packageId>` deep link.
   * Deliberately has NO `https://stella.sh/store/...` web form yet — the
   * website half is intentionally unbuilt, so store links pasted outside
   * Stella don't resolve in browsers until that trust/safety call is made.
   */
  | { kind: "view-store-package"; authorUsername: string; packageId: string };

/** Strip the display hyphen ("ABCD-EFGH" → "ABCDEFGH") and uppercase. */
const normalizeInviteCode = (raw: string): string =>
  raw.replace(/-/g, "").toUpperCase();

export const buildCommunityInviteLink = (inviteCode: string): string =>
  `https://${WEB_HOST}/join/${normalizeInviteCode(inviteCode)}`;

export const buildFriendInviteLink = (username: string): string =>
  `https://${WEB_HOST}/add-friend/${username.trim().toLowerCase()}`;

/**
 * Parse a message body / deep link that is exactly a social invite link.
 * Accepts the deep-link form (protocol `deepLinkProtocol`, default
 * "stella") and the `https://stella.sh/...` web form.
 */
export const parseSocialInviteLink = (
  input: string,
  options?: { deepLinkProtocol?: string },
): SocialInvite | null => {
  const trimmed = input.trim();
  if (!trimmed || !HAS_SCHEME_PATTERN.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase().replace(/:$/, "");
  const deepLinkProtocol = (
    options?.deepLinkProtocol ?? "stella"
  ).toLowerCase();
  let action: string;
  let value: string;
  const segments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (protocol === deepLinkProtocol) {
    // stella://join/<code> — the action is the hostname.
    action = parsed.hostname.trim().toLowerCase();
    if (action === "store") {
      // Deep-link-only (no web form; see `view-store-package` above).
      if (segments.length !== 2) return null;
      const authorUsername = segments[0]!;
      const packageId = segments[1]!;
      if (
        !USERNAME_PATTERN.test(authorUsername) ||
        !PACKAGE_ID_PATTERN.test(packageId)
      ) {
        return null;
      }
      return {
        kind: "view-store-package",
        authorUsername: authorUsername.toLowerCase(),
        packageId: packageId.toLowerCase(),
      };
    }
    if (segments.length !== 1) return null;
    value = segments[0]!;
  } else if (protocol === "https" || protocol === "http") {
    if (parsed.hostname.trim().toLowerCase() !== WEB_HOST) return null;
    if (segments.length !== 2) return null;
    action = segments[0]!.toLowerCase();
    value = segments[1]!;
  } else {
    return null;
  }

  if (action === "join" && INVITE_CODE_PATTERN.test(value)) {
    return { kind: "join-community", inviteCode: normalizeInviteCode(value) };
  }
  if (action === "add-friend" && USERNAME_PATTERN.test(value)) {
    return { kind: "add-friend", username: value.toLowerCase() };
  }
  return null;
};
