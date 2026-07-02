// Social invite links: join-a-community and add-a-friend.
//
// Two equivalent forms per invite:
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
// Parsing is anchored to the whole message body, like `parseShareLink` —
// mid-sentence links intentionally don't trigger card embeds.

const WEB_HOST = "stella.sh";

const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]{8,9}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type SocialInvite =
  | { kind: "join-community"; inviteCode: string }
  | { kind: "add-friend"; username: string };

/** Strip the display hyphen ("ABCD-EFGH" → "ABCDEFGH") and uppercase. */
const normalizeInviteCode = (raw: string): string =>
  raw.replace(/-/g, "").toUpperCase();

export const buildCommunityInviteLink = (inviteCode: string): string =>
  `https://${WEB_HOST}/join/${normalizeInviteCode(inviteCode)}`;

export const buildFriendInviteLink = (username: string): string =>
  `https://${WEB_HOST}/add-friend/${username.trim().toLowerCase()}`;

/**
 * Parse a message body / deep link that is exactly a social invite link.
 * Accepts the `stella://` deep-link form and the `https://stella.sh/...`
 * web form.
 */
export const parseSocialInviteLink = (input: string): SocialInvite | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase().replace(/:$/, "");
  let action: string;
  let value: string;
  const segments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (protocol === "stella") {
    // stella://join/<code> — the action is the hostname.
    if (segments.length !== 1) return null;
    action = parsed.hostname.trim().toLowerCase();
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
